import {
  CommandId,
  type ChangeRequestState,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { resolveThreadWorkspaceCwd } from "../checkpointing/Utils.ts";
import { forkParked } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { normalizeSourceBranch } from "../sourceControl/SourceControlProvider.ts";
import { SourceControlProviderRegistry } from "../sourceControl/SourceControlProviderRegistry.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { resolveAutomaticSettlementReason } from "./threadSettlement.ts";

const RECONCILE_INTERVAL = Duration.minutes(1);
const CHANGE_REQUEST_LOOKUP_TTL = Duration.minutes(2);
const CHANGE_REQUEST_LOOKUP_FAILURE_TTL = Duration.seconds(20);
const MAX_BRANCH_LOOKUPS_PER_RECONCILE = 20;
const CHANGE_REQUEST_LOOKUP_FAILED = Symbol("CHANGE_REQUEST_LOOKUP_FAILED");

export class ThreadSettlementReactor extends Context.Service<
  ThreadSettlementReactor,
  {
    /** Start the persisted inactivity and merged-PR settlement lifecycle. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;

    /** Resolves when all automatic settlement work already queued is complete. */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/ThreadSettlementReactor") {}

function workspaceCwd(
  thread: Pick<OrchestrationThreadShell, "projectId" | "worktreePath">,
  projects: ReadonlyArray<OrchestrationProjectShell>,
): string | undefined {
  return resolveThreadWorkspaceCwd({ thread, projects });
}

function refsMatch(left: string, right: string): boolean {
  return normalizeSourceBranch(left) === normalizeSourceBranch(right);
}

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const serverSettings = yield* ServerSettingsService;
  const sourceControlProviders = yield* SourceControlProviderRegistry;
  const branchCursor = yield* Ref.make(0);

  const branchLookupCache = yield* Cache.makeWith(
    (key: string) => {
      const [cwd = "", branch = ""] = key.split("\u0000");
      return sourceControlProviders.resolve({ cwd }).pipe(
        Effect.flatMap((provider) =>
          provider.listChangeRequests({
            cwd,
            headSelector: branch,
            state: "all",
            limit: 20,
          }),
        ),
        Effect.map((changeRequests): ChangeRequestState | null => {
          const matching = changeRequests.filter((changeRequest) =>
            refsMatch(changeRequest.headRefName, branch),
          );
          return (
            matching.find((changeRequest) => changeRequest.state === "open")?.state ??
            matching.find((changeRequest) => changeRequest.state === "merged")?.state ??
            matching[0]?.state ??
            null
          );
        }),
      );
    },
    {
      capacity: 2_048,
      timeToLive: (exit) =>
        Exit.isSuccess(exit) ? CHANGE_REQUEST_LOOKUP_TTL : CHANGE_REQUEST_LOOKUP_FAILURE_TTL,
    },
  );

  const dispatchSettlement = Effect.fn("ThreadSettlementReactor.dispatchSettlement")(function* (
    thread: OrchestrationThreadShell,
    reason: "inactivity" | "pr-merged",
  ) {
    const commandId = CommandId.make(
      `server:thread-auto-settle:${reason}:${yield* crypto.randomUUIDv4}`,
    );
    yield* orchestrationEngine.dispatch({
      type: "thread.settle",
      commandId,
      threadId: thread.id,
    });
  });

  const dispatchSettlementSafely = (
    thread: OrchestrationThreadShell,
    reason: "inactivity" | "pr-merged",
  ) =>
    dispatchSettlement(thread, reason).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
        return Effect.logDebug("automatic thread settlement skipped after a raced state change", {
          threadId: thread.id,
          reason,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const lookupBranchChangeRequestState = (cwd: string, branch: string) =>
    Cache.get(branchLookupCache, `${cwd}\u0000${branch}`).pipe(
      Effect.catch((error) =>
        Effect.logDebug("automatic thread settlement could not read change request state", {
          cwdLength: cwd.length,
          branch,
          errorTag: error._tag,
        }).pipe(Effect.as(CHANGE_REQUEST_LOOKUP_FAILED)),
      ),
    );

  const resolveThreadChangeRequestState = Effect.fn(
    "ThreadSettlementReactor.resolveThreadChangeRequestState",
  )(function* (input: {
    readonly thread: OrchestrationThreadShell;
    readonly cwd: string | undefined;
  }): Effect.fn.Return<ChangeRequestState | null | typeof CHANGE_REQUEST_LOOKUP_FAILED> {
    const branch = input.thread.branch;
    if (branch === null || input.cwd === undefined) return null;
    return yield* lookupBranchChangeRequestState(input.cwd, branch);
  });

  const reconcile = Effect.fn("ThreadSettlementReactor.reconcile")(function* () {
    const [snapshot, settings, now] = yield* Effect.all([
      projectionSnapshotQuery.getShellSnapshot(),
      serverSettings.getSettings,
      DateTime.now,
    ]);
    const nowIso = DateTime.formatIso(now);
    const eligibleThreads = snapshot.threads.filter((thread) => thread.settledOverride === null);
    const cwdByThreadId = new Map(
      eligibleThreads.map(
        (thread) => [thread.id, workspaceCwd(thread, snapshot.projects)] as const,
      ),
    );
    const threadsWithoutChangeRequestLookup = eligibleThreads.filter(
      (thread) => thread.branch === null || cwdByThreadId.get(thread.id) === undefined,
    );
    const branchThreads = eligibleThreads.filter(
      (thread) => thread.branch !== null && cwdByThreadId.get(thread.id) !== undefined,
    );
    const branchStart =
      branchThreads.length === 0 ? 0 : (yield* Ref.get(branchCursor)) % branchThreads.length;
    const branchCount = Math.min(MAX_BRANCH_LOOKUPS_PER_RECONCILE, branchThreads.length);
    const selectedBranchThreads = Array.from(
      { length: branchCount },
      (_, offset) => branchThreads[(branchStart + offset) % branchThreads.length]!,
    );
    if (branchThreads.length > 0) {
      yield* Ref.set(branchCursor, (branchStart + branchCount) % branchThreads.length);
    }

    yield* Effect.forEach(
      threadsWithoutChangeRequestLookup,
      (thread) => {
        const reason = resolveAutomaticSettlementReason(thread, {
          now: nowIso,
          autoSettleAfterDays: settings.threadAutoSettleAfterDays,
          changeRequestState: null,
        });
        return reason === null ? Effect.void : dispatchSettlementSafely(thread, reason);
      },
      { concurrency: 4, discard: true },
    );

    // Branch state is remote provider work. Bound each pass and rotate the
    // cursor so a large first-run history converges without launching one CLI
    // process per thread at startup.
    yield* Effect.forEach(
      selectedBranchThreads,
      (thread) =>
        resolveThreadChangeRequestState({
          thread,
          cwd: cwdByThreadId.get(thread.id),
        }).pipe(
          Effect.flatMap((changeRequestState) => {
            // A failed lookup is unknown, not evidence that no PR exists.
            // Fail closed so a transient provider outage cannot hide live work.
            if (changeRequestState === CHANGE_REQUEST_LOOKUP_FAILED) return Effect.void;
            const reason = resolveAutomaticSettlementReason(thread, {
              now: nowIso,
              autoSettleAfterDays: settings.threadAutoSettleAfterDays,
              changeRequestState,
            });
            return reason === null ? Effect.void : dispatchSettlementSafely(thread, reason);
          }),
        ),
      { concurrency: 4, discard: true },
    );
  });

  const reconcileSafely = reconcile().pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
      return Effect.logWarning("thread settlement reactor failed to reconcile", {
        cause: Cause.pretty(cause),
      });
    }),
  );

  const worker = yield* makeDrainableWorker((_input: void) => reconcileSafely);

  const start: ThreadSettlementReactor["Service"]["start"] = Effect.fn(
    "ThreadSettlementReactor.start",
  )(function* () {
    yield* forkParked(
      Stream.runForEach(serverSettings.streamChanges, () => worker.enqueue(undefined)),
    );
    yield* worker.enqueue(undefined);
    yield* forkParked(
      Effect.sleep(RECONCILE_INTERVAL).pipe(
        Effect.andThen(worker.enqueue(undefined)),
        Effect.forever,
      ),
    );
  });

  return ThreadSettlementReactor.of({
    start,
    drain: worker.drain,
  });
});

export const layer = Layer.effect(ThreadSettlementReactor, make);
