import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  ProviderInstanceId,
  SourceControlProviderError,
  ThreadId,
  TurnId,
  type ChangeRequest,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { ServerSettingsService } from "../serverSettings.ts";
import * as SourceControlProvider from "../sourceControl/SourceControlProvider.ts";
import { SourceControlProviderRegistry } from "../sourceControl/SourceControlProviderRegistry.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "./Services/ProjectionSnapshotQuery.ts";
import { make } from "./ThreadSettlementReactor.ts";

const projectId = ProjectId.make("project-1");
const project: OrchestrationProjectShell = {
  id: projectId,
  title: "Project",
  workspaceRoot: "/repo",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2020-01-01T00:00:00.000Z",
  updatedAt: "2020-01-01T00:00:00.000Z",
};

function makeThread(input: {
  readonly id: string;
  readonly branch: string;
  readonly pinned?: boolean;
}): OrchestrationThreadShell {
  const threadId = ThreadId.make(input.id);
  return {
    id: threadId,
    projectId,
    title: input.id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: input.branch,
    worktreePath: null,
    latestTurn: {
      turnId: TurnId.make(`turn-${input.id}`),
      state: "completed",
      // @effect/vitest's test clock starts at the Unix epoch.
      requestedAt: "1960-01-01T00:00:00.000Z",
      startedAt: null,
      completedAt: null,
      assistantMessageId: null,
    },
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-01-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    ...(input.pinned ? { pinnedAt: "2020-01-02T00:00:00.000Z" } : {}),
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

function changeRequest(headRefName: string, state: ChangeRequest["state"]): ChangeRequest {
  return {
    provider: "github",
    number: 1,
    title: headRefName,
    url: `https://example.test/${headRefName}`,
    baseRefName: "main",
    headRefName,
    state,
    updatedAt: Option.none(),
  };
}

it.effect(
  "persists inactivity and merged-PR settlement while leaving pinned closed PRs alone",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const inactivity = makeThread({ id: "inactivity", branch: "feature/inactivity" });
        const pinnedClosed = makeThread({
          id: "pinned-closed",
          branch: "feature/closed",
          pinned: true,
        });
        const pinnedMerged = makeThread({
          id: "pinned-merged",
          branch: "feature/merged",
          pinned: true,
        });
        const pinnedMixed = makeThread({
          id: "pinned-mixed",
          branch: "feature/mixed",
          pinned: true,
        });
        const snapshot = {
          snapshotSequence: 1,
          projects: [project],
          threads: [inactivity, pinnedClosed, pinnedMerged, pinnedMixed],
          updatedAt: "2020-01-02T00:00:00.000Z",
        } satisfies OrchestrationShellSnapshot;
        const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);

        const provider = {
          listChangeRequests: (
            input: Parameters<
              SourceControlProvider.SourceControlProvider["Service"]["listChangeRequests"]
            >[0],
          ) =>
            Effect.succeed(
              input.headSelector === pinnedClosed.branch
                ? [changeRequest(input.headSelector, "closed")]
                : input.headSelector === pinnedMerged.branch
                  ? [changeRequest(input.headSelector, "merged")]
                  : input.headSelector === pinnedMixed.branch
                    ? [
                        changeRequest(input.headSelector, "closed"),
                        changeRequest(input.headSelector, "merged"),
                      ]
                    : [],
            ),
        } as unknown as SourceControlProvider.SourceControlProvider["Service"];

        const dependencies = Layer.mergeAll(
          Layer.succeed(OrchestrationEngineService, {
            readEvents: () => Stream.empty,
            dispatch: (command) =>
              Ref.update(dispatched, (commands) => [...commands, command]).pipe(
                Effect.as({ sequence: 1 }),
              ),
            streamDomainEvents: Stream.empty,
            latestSequence: Effect.succeed(0),
          } satisfies OrchestrationEngineShape),
          Layer.succeed(ProjectionSnapshotQuery, {
            getShellSnapshot: () => Effect.succeed(snapshot),
          } as unknown as ProjectionSnapshotQueryShape),
          ServerSettingsService.layerTest(),
          Layer.mock(SourceControlProviderRegistry)({
            resolve: () => Effect.succeed(provider),
          }),
          NodeServices.layer,
        );

        const reactor = yield* make.pipe(Effect.provide(dependencies));
        yield* reactor.start();
        yield* reactor.drain;

        const settledThreadIds = (yield* Ref.get(dispatched))
          .filter((command) => command.type === "thread.settle")
          .map((command) => command.threadId)
          .sort();
        expect(settledThreadIds).toEqual([inactivity.id, pinnedMerged.id, pinnedMixed.id].sort());
      }),
    ),
);

it.effect("does not settle a stale thread when its PR state lookup fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const thread = makeThread({ id: "lookup-failed", branch: "feature/open-pr" });
      const snapshot = {
        snapshotSequence: 1,
        projects: [project],
        threads: [thread],
        updatedAt: "2020-01-02T00:00:00.000Z",
      } satisfies OrchestrationShellSnapshot;
      const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const provider = {
        listChangeRequests: () =>
          Effect.fail(
            new SourceControlProviderError({
              provider: "github",
              operation: "listChangeRequests",
              cwd: project.workspaceRoot,
              detail: "temporary lookup failure",
            }),
          ),
      } as unknown as SourceControlProvider.SourceControlProvider["Service"];
      const dependencies = Layer.mergeAll(
        Layer.succeed(OrchestrationEngineService, {
          readEvents: () => Stream.empty,
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.as({ sequence: 1 }),
            ),
          streamDomainEvents: Stream.empty,
          latestSequence: Effect.succeed(0),
        } satisfies OrchestrationEngineShape),
        Layer.succeed(ProjectionSnapshotQuery, {
          getShellSnapshot: () => Effect.succeed(snapshot),
        } as unknown as ProjectionSnapshotQueryShape),
        ServerSettingsService.layerTest(),
        Layer.mock(SourceControlProviderRegistry)({
          resolve: () => Effect.succeed(provider),
        }),
        NodeServices.layer,
      );

      const reactor = yield* make.pipe(Effect.provide(dependencies));
      yield* reactor.start();
      yield* reactor.drain;

      expect(yield* Ref.get(dispatched)).toEqual([]);
    }),
  ),
);
