// @effect-diagnostics nodeBuiltinImport:off
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProviderDriverKind,
  ProviderInstanceId,
  ReviewId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { RuntimeReceiptBusLive } from "./RuntimeReceiptBus.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ReviewReactor } from "../Services/ReviewReactor.ts";
import { RuntimeReceiptBus } from "../Services/RuntimeReceiptBus.ts";
import { ReviewReactorLive } from "./ReviewReactor.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import * as GitManager from "../../git/GitManager.ts";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import * as ServerConfig from "../../config.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const asProjectId = (v: string) => v as never;

function runGit(cwd: string, args: ReadonlyArray<string>) {
  return NodeChildProcess.execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

function createGitRepository() {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-review-reactor-"));
  runGit(cwd, ["init", "--initial-branch=main"]);
  runGit(cwd, ["config", "user.email", "test@example.com"]);
  runGit(cwd, ["config", "user.name", "Test User"]);
  NodeFS.writeFileSync(NodePath.join(cwd, "README.md"), "v1\n", "utf8");
  runGit(cwd, ["add", "."]);
  runGit(cwd, ["commit", "-m", "Initial"]);
  return cwd;
}

interface ProviderHarness {
  readonly service: ProviderServiceShape;
  readonly emit: (event: ProviderRuntimeEvent) => void;
  readonly startSessions: Array<ProviderSessionStartInput>;
  readonly sendTurns: Array<ProviderSendTurnInput>;
  readonly stoppedSessions: Array<ThreadId>;
}

function createProviderHarness(providerName = ProviderDriverKind.make("omp")): ProviderHarness {
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
  const startSessions: Array<ProviderSessionStartInput> = [];
  const sendTurns: Array<ProviderSendTurnInput> = [];
  const stoppedSessions: Array<ThreadId> = [];

  const sessionFor = (input: ProviderSessionStartInput): ProviderSession => ({
    provider: providerName,
    providerInstanceId: input.providerInstanceId,
    status: "ready",
    runtimeMode: input.runtimeMode,
    cwd: input.cwd,
    threadId: input.threadId,
    createdAt: NOW,
    updatedAt: NOW,
  });

  const service: ProviderServiceShape = {
    startSession: (threadId, input) => {
      startSessions.push({ ...input, threadId });
      return Effect.succeed(sessionFor({ ...input, threadId }));
    },
    sendTurn: (input) => {
      sendTurns.push(input);
      return Effect.succeed({ threadId: input.threadId, turnId: TurnId.make("turn-1") });
    },
    interruptTurn: () => Effect.void,
    respondToRequest: () => Effect.void,
    respondToUserInput: () => Effect.void,
    stopSession: (input) => {
      stoppedSessions.push(input.threadId);
      return Effect.void;
    },
    listSessions: () => Effect.succeed([]),
    getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
    getInstanceInfo: (instanceId) =>
      Effect.succeed({
        instanceId,
        driverKind: providerName,
        displayName: undefined,
        enabled: true,
        continuationIdentity: {
          driverKind: providerName,
          continuationKey: `${providerName}:${instanceId}`,
        },
      }),
    rollbackConversation: () => Effect.void,
    ompGetSubagentMessages: () => Effect.die("not used"),
    ompSteer: () => Effect.die("not used"),
    ompSetSubagentSubscription: () => Effect.die("not used"),
    reconcileStaleSessions: () => Effect.die("not used"),
    get streamEvents() {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  };

  const emit = (event: ProviderRuntimeEvent): void => {
    Effect.runSync(PubSub.publish(runtimeEventPubSub, event));
  };

  return { service, emit, startSessions, sendTurns, stoppedSessions };
}

describe("ReviewReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    OrchestrationEngineService | ProjectionSnapshotQuery | ReviewReactor | RuntimeReceiptBus,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const tempDirs: string[] = [];

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  async function createHarness() {
    const cwd = createGitRepository();
    tempDirs.push(cwd);
    const provider = createProviderHarness();

    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(ThreadPlanProgress.layer),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    );
    const projectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(ThreadPlanProgress.layer),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    );
    const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-review-reactor-test-",
    });

    const gitManagerStub = {} as never as GitManager.GitManager["Service"];
    const gitWorkflowStub = {} as never as GitWorkflowService.GitWorkflowService["Service"];

    const layer = ReviewReactorLive.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(projectionSnapshotLayer),
      Layer.provideMerge(RuntimeReceiptBusLive),
      Layer.provideMerge(Layer.succeed(ProviderService, provider.service)),
      Layer.provideMerge(Layer.succeed(GitManager.GitManager, gitManagerStub)),
      Layer.provideMerge(Layer.succeed(GitWorkflowService.GitWorkflowService, gitWorkflowStub)),
      Layer.provideMerge(serverConfigLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    runtime = ManagedRuntime.make(layer);
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const reactor = await runtime.runPromise(Effect.service(ReviewReactor));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));

    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-create"),
        projectId: asProjectId("project-1"),
        title: "Test Project",
        workspaceRoot: cwd,
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("omp"),
          model: "gpt-5",
        },
        createdAt: NOW,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create"),
        threadId: ThreadId.make("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("omp"), model: "gpt-5" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: cwd,
        createdAt: NOW,
      }),
    );

    const readReviewRuns = async () => {
      const model = await runtime!.runPromise(
        Effect.service(ProjectionSnapshotQuery).pipe(Effect.flatMap((q) => q.getSnapshot())),
      );
      return model.reviewRuns ?? [];
    };

    return { engine, reactor, provider, cwd, readReviewRuns };
  }

  async function waitForCondition(
    predicate: () => Promise<boolean>,
    description: string,
    timeoutMs = 15_000,
  ) {
    const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
    const poll = async (): Promise<void> => {
      if (await predicate()) {
        return;
      }
      if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
        throw new Error(`Timed out waiting for ${description}.`);
      }
      await Effect.runPromise(Effect.sleep("10 millis"));
      return poll();
    };
    return poll();
  }

  it("runs a working-tree review end to end and records findings", async () => {
    const h = await createHarness();
    // Production review ids are bare UUIDs; the reactor namespaces the
    // provider session thread id with `review-` so ingestion skips its
    // events and this reactor consumes them.
    const reviewId = ReviewId.make("6b8f4a1e-9c2d-4f3a-8b7e-1d2c3a4b5c6d");

    await Effect.runPromise(
      h.engine.dispatch({
        type: "review.start",
        commandId: CommandId.make("cmd-review-start"),
        reviewId,
        source: { kind: "working-tree" },
        threadRef: { environmentId: "env-1" as never, threadId: ThreadId.make("thread-1") },
        environmentId: "env-1" as never,
        projectId: asProjectId("project-1"),
        createdAt: NOW,
      }),
    );

    await waitForCondition(async () => h.provider.sendTurns.length === 1, "review sendTurn issued");
    expect(h.provider.startSessions.length).toBe(1);
    expect(h.provider.startSessions[0]?.threadId).toBe(ThreadId.make(`review-${reviewId}`));
    expect(h.provider.startSessions[0]?.cwd).toBe(h.cwd);
    expect(h.provider.sendTurns[0]?.interactionMode).toBe("review");
    expect(h.provider.sendTurns[0]?.input ?? "").toContain("senior code reviewer");

    // The agent's live tool calls stream into the run's progress.
    h.provider.emit({
      type: "item.started",
      eventId: "evt-progress-1" as never,
      provider: ProviderDriverKind.make("omp"),
      threadId: ThreadId.make(`review-${reviewId}`),
      createdAt: NOW,
      turnId: TurnId.make("turn-1"),
      payload: { itemType: "dynamic_tool_call", title: "read", detail: "README.md" },
    });
    h.provider.emit({
      type: "thread.token-usage.updated",
      eventId: "evt-progress-2" as never,
      provider: ProviderDriverKind.make("omp"),
      threadId: ThreadId.make(`review-${reviewId}`),
      createdAt: NOW,
      turnId: TurnId.make("turn-1"),
      payload: { usage: { usedTokens: 42_000 } },
    });
    await waitForCondition(async () => {
      const runs = await h.readReviewRuns();
      return runs.find((entry) => entry.id === reviewId)?.progress?.activity.length === 1;
    }, "review progress recorded");
    let run = (await h.readReviewRuns()).find((entry) => entry.id === reviewId);
    expect(run?.progress?.activity[0]).toMatchObject({ kind: "read", title: "README.md" });

    // Review-session subagents (the orchestrator's per-file passes) fold into
    // the same live progress strip. The entry lands inside the throttle window,
    // so it surfaces on the terminal flush alongside the token total.
    h.provider.emit({
      type: "task.started",
      eventId: "evt-progress-3" as never,
      provider: ProviderDriverKind.make("omp"),
      threadId: ThreadId.make(`review-${reviewId}`),
      createdAt: NOW,
      turnId: TurnId.make("turn-1"),
      payload: { taskId: RuntimeTaskId.make("task-1"), description: "review src/a.ts" },
    });

    h.provider.emit({
      type: "review.finding",
      eventId: "evt-1" as never,
      provider: ProviderDriverKind.make("omp"),
      threadId: ThreadId.make(`review-${reviewId}`),
      createdAt: NOW,
      turnId: TurnId.make("turn-1"),
      payload: {
        id: "finding-1",
        file: "README.md",
        line: 1,
        side: "right",
        severity: "nit",
        message: "Example finding.",
        symbol: null,
      },
    });
    h.provider.emit({
      type: "turn.completed",
      eventId: "evt-2" as never,
      provider: ProviderDriverKind.make("omp"),
      threadId: ThreadId.make(`review-${reviewId}`),
      createdAt: NOW,
      turnId: TurnId.make("turn-1"),
      payload: {
        state: "completed",
        verdict: "request-changes",
        summary: "The change needs work.",
        filesReviewed: ["README.md"],
      },
    });

    await waitForCondition(async () => {
      const runs = await h.readReviewRuns();
      return runs.some((run) => run.id === reviewId && run.status === "completed");
    }, "review run completed");
    const runs = await h.readReviewRuns();
    run = runs.find((entry) => entry.id === reviewId);
    expect(run?.status).toBe("completed");
    expect(run?.findings).toHaveLength(1);
    expect(run?.findings[0]?.file).toBe("README.md");
    expect(run?.verdict).toBe("request-changes");
    expect(run?.summary).toBe("The change needs work.");
    expect(run?.filesReviewed).toEqual(["README.md"]);
    // Token usage landed inside the throttle window and is flushed with the
    // terminal frame, which also carries the subagent fold.
    expect(run?.progress?.tokensUsed).toBe(42_000);
    expect(run?.progress?.activity.some((item) => item.kind === "subagent")).toBe(true);
    expect(run?.progress?.activity.at(-1)).toMatchObject({
      kind: "subagent",
      title: "review src/a.ts",
    });
    expect(h.provider.stoppedSessions).toContain(ThreadId.make(`review-${reviewId}`));
  });

  it("fails the review when the turn fails", async () => {
    const h = await createHarness();
    const reviewId = ReviewId.make("8a4f2c6e-3b7d-4e9a-a1c5-6f8d2e4b9a7c");

    await Effect.runPromise(
      h.engine.dispatch({
        type: "review.start",
        commandId: CommandId.make("cmd-review-start-2"),
        reviewId,
        source: { kind: "working-tree" },
        threadRef: { environmentId: "env-1" as never, threadId: ThreadId.make("thread-1") },
        environmentId: "env-1" as never,
        projectId: asProjectId("project-1"),
        createdAt: NOW,
      }),
    );

    await waitForCondition(async () => h.provider.sendTurns.length === 1, "review sendTurn issued");
    h.provider.emit({
      type: "turn.completed",
      eventId: "evt-3" as never,
      provider: ProviderDriverKind.make("omp"),
      threadId: ThreadId.make(`review-${reviewId}`),
      createdAt: NOW,
      turnId: TurnId.make("turn-1"),
      payload: { state: "failed", errorMessage: "Findings JSON was malformed" },
    });

    await waitForCondition(async () => {
      const runs = await h.readReviewRuns();
      return runs.some((run) => run.id === reviewId && run.status === "failed");
    }, "review run failed");
    const runs = await h.readReviewRuns();
    const run = runs.find((entry) => entry.id === reviewId);
    expect(run?.status).toBe("failed");
    expect(run?.errorMessage).toBe("Findings JSON was malformed");
  });
});
