import type {
  EnvironmentId,
  OrchestrationCommand,
  OrchestrationProject,
  OrchestrationReadModel,
  OrchestrationThread,
  ProjectId,
  ReviewId,
  ReviewFinding,
  ReviewRun,
  ReviewSource,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Effect from "effect/Effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";

function invariantError(commandType: string, detail: string): OrchestrationCommandInvariantError {
  return new OrchestrationCommandInvariantError({
    commandType,
    detail,
  });
}

export function findThreadById(
  readModel: OrchestrationReadModel,
  threadId: ThreadId,
): OrchestrationThread | undefined {
  return readModel.threads.find((thread) => thread.id === threadId);
}

export function findProjectById(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): OrchestrationProject | undefined {
  return readModel.projects.find((project) => project.id === projectId);
}

export function listThreadsByProjectId(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): ReadonlyArray<OrchestrationThread> {
  return readModel.threads.filter((thread) => thread.projectId === projectId);
}

export function requireProject(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<OrchestrationProject, OrchestrationCommandInvariantError> {
  const project = findProjectById(input.readModel, input.projectId);
  if (project) {
    return Effect.succeed(project);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireProjectAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findProjectById(input.readModel, input.projectId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' already exists and cannot be created twice.`,
    ),
  );
}

export function requireActiveProjectWorkspaceRootAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly workspaceRoot: string;
  readonly exceptProjectId?: ProjectId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  const normalizedWorkspaceRoot = normalizeProjectPathForComparison(input.workspaceRoot);
  const existingProject = input.readModel.projects.find(
    (project) =>
      project.deletedAt === null &&
      normalizeProjectPathForComparison(project.workspaceRoot) === normalizedWorkspaceRoot &&
      project.id !== input.exceptProjectId,
  );
  if (existingProject === undefined) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Active project '${existingProject.id}' already exists for workspace root '${normalizedWorkspaceRoot}'.`,
    ),
  );
}

export function requireThread(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  const thread = findThreadById(input.readModel, input.threadId);
  if (thread) {
    return Effect.succeed(thread);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Thread '${input.threadId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireThreadArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      thread.archivedAt !== null
        ? Effect.succeed(thread)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' is not archived for command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireThreadNotArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      thread.archivedAt === null
        ? Effect.succeed(thread)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' is already archived and cannot handle command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireThreadAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findThreadById(input.readModel, input.threadId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Thread '${input.threadId}' already exists and cannot be created twice.`,
    ),
  );
}

export function requireNonNegativeInteger(input: {
  readonly commandType: OrchestrationCommand["type"];
  readonly field: string;
  readonly value: number;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (Number.isInteger(input.value) && input.value >= 0) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.commandType,
      `${input.field} must be an integer greater than or equal to 0.`,
    ),
  );
}

export function findReviewById(
  readModel: OrchestrationReadModel,
  reviewId: ReviewId,
): ReviewRun | undefined {
  return (readModel.reviewRuns ?? []).find((run) => run.id === reviewId);
}

function sameThreadRef(left: ScopedThreadRef, right: ScopedThreadRef): boolean {
  return left.environmentId === right.environmentId && left.threadId === right.threadId;
}

function sourceIdentityKey(source: ReviewSource): string {
  switch (source.kind) {
    case "working-tree":
      return "working-tree";
    case "branch-range":
      return `branch-range:${source.baseRef ?? ""}`;
    case "pr":
      return `pr:${source.host}/${source.repository}#${source.number}`;
  }
}

/**
 * D13: one active review per (source identity, environment) and per host
 * thread. A working-tree / branch-range review is tied to the host thread's
 * workspace; a pr review is tied to the pull request. A completed or failed
 * run is never a conflict, so a user can re-review after dismissing.
 */
function hasActiveReviewConflict(
  readModel: OrchestrationReadModel,
  input: {
    readonly reviewId: ReviewId;
    readonly source: ReviewSource;
    readonly threadRef: ScopedThreadRef | null;
    readonly environmentId: EnvironmentId;
  },
): boolean {
  for (const run of readModel.reviewRuns ?? []) {
    if (run.status !== "running") continue;
    if (run.id === input.reviewId) return true;
    if (input.threadRef && run.threadRef && sameThreadRef(run.threadRef, input.threadRef)) {
      return true;
    }
    if (
      run.environmentId === input.environmentId &&
      sourceIdentityKey(run.source) === sourceIdentityKey(input.source)
    ) {
      return true;
    }
  }
  return false;
}

export function requireReviewAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly reviewId: ReviewId;
  readonly source: ReviewSource;
  readonly threadRef: ScopedThreadRef | null;
  readonly environmentId: EnvironmentId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!hasActiveReviewConflict(input.readModel, input)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `A review is already running for this change; finish or dismiss it before starting another.`,
    ),
  );
}

export function requireReviewRunning(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly reviewId: ReviewId;
}): Effect.Effect<ReviewRun, OrchestrationCommandInvariantError> {
  const run = findReviewById(input.readModel, input.reviewId);
  if (run && run.status === "running") {
    return Effect.succeed(run);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Review '${input.reviewId}' is not running and cannot handle command '${input.command.type}'.`,
    ),
  );
}

export function requireReviewFinding(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly reviewId: ReviewId;
  readonly findingId: string;
}): Effect.Effect<ReviewFinding, OrchestrationCommandInvariantError> {
  const run = findReviewById(input.readModel, input.reviewId);
  const finding = run?.findings.find((candidate) => candidate.id === input.findingId);
  if (run !== undefined && finding !== undefined) {
    return Effect.succeed(finding);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Review '${input.reviewId}' has no finding '${input.findingId}'.`,
    ),
  );
}
