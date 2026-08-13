/**
 * OmpAdapter — maps omp RPC session frames onto ProviderRuntimeEvent.
 *
 * Turn completion (AC11): terminal `agent_end` (`isTerminal !== false`),
 * prompt `data.agentInvoked === false`, and `prompt_result` with
 * `agentInvoked: false`. Empty assistant deltas are not emitted (AC2).
 * Subagents (AC7): `set_subagent_subscription` + `subagent_*` → `task.*`.
 *
 * @module provider/omp/OmpAdapter
 */
import {
  type ApprovalRequestId,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderSendTurnInput,
  type ProviderUserInputAnswers,
  type RuntimeTaskStatus,
  type ServerProviderModel,
  ProviderDriverKind,
  RuntimeTaskId,
  type RuntimeMode,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { OmpRpcRuntime } from "./OmpRpcRuntime.ts";

const PROVIDER = ProviderDriverKind.make("omp");
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface LiveAdapterSession {
  readonly threadId: ThreadId;
  readonly sessionFile: string;
  readonly runtimeMode: RuntimeMode;
  readonly cwd: string;
  readonly snapshot: ProviderSession;
  turnId: TurnId | undefined;
}

/**
 * Structural RPC client used by the adapter. Tests pass a fake; production
 * passes `OmpRpcRuntime`.
 */
export type OmpRpcClient = Pick<
  OmpRpcRuntime,
  "ensureSession" | "send" | "streamFrames" | "dispose"
>;

export class OmpAdapter {
  readonly provider = PROVIDER;
  readonly capabilities = { sessionModelSwitch: "in-session" as const };
  readonly #events = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
  readonly #sessions = new Map<ThreadId, LiveAdapterSession>();

  public constructor(private readonly runtime: OmpRpcClient) {}

  public get streamEvents(): Stream.Stream<ProviderRuntimeEvent> {
    return Stream.fromQueue(this.#events);
  }

  public startSession(input: ProviderSessionStartInput) {
    return Effect.gen({ self: this }, function* () {
      const cwd = input.cwd;
      if (cwd === undefined) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: "cwd is required",
        });
      }
      const resumeCursor = typeof input.resumeCursor === "string" ? input.resumeCursor : null;
      const handle = yield* this.runtime.ensureSession({
        sessionKey: input.threadId,
        cwd,
        resumeCursor,
      });
      const createdAt = yield* nowIso;
      const snapshot: ProviderSession = {
        provider: PROVIDER,
        status: "ready",
        runtimeMode: input.runtimeMode,
        cwd,
        threadId: input.threadId,
        resumeCursor: handle.sessionFile,
        createdAt,
        updatedAt: createdAt,
      };
      const session: LiveAdapterSession = {
        threadId: input.threadId,
        sessionFile: handle.sessionFile,
        runtimeMode: input.runtimeMode,
        cwd,
        snapshot,
        turnId: undefined,
      };
      this.#sessions.set(input.threadId, session);
      yield* this.runtime.streamFrames(input.threadId).pipe(
        Stream.runForEach((frame) => this.#onFrame(session, frame)),
        Effect.forkScoped,
      );
      yield* this.runtime.send(input.threadId, {
        type: "set_subagent_subscription",
        level: "progress",
      });
      yield* this.#applyModelSelection(input.threadId, input.modelSelection?.model);
      return snapshot;
    });
  }

  public sendTurn(input: ProviderSendTurnInput) {
    return Effect.gen({ self: this }, function* () {
      const session = this.#sessions.get(input.threadId);
      if (!session) {
        return yield* new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId: input.threadId,
        });
      }
      const turnId = TurnId.make(globalThis.crypto.randomUUID());
      session.turnId = turnId;
      yield* this.#applyModelSelection(input.threadId, input.modelSelection?.model);
      yield* this.#emit({
        type: "turn.started",
        threadId: input.threadId,
        turnId,
        payload: input.modelSelection?.model ? { model: input.modelSelection.model } : {},
      });
      const response = yield* this.runtime.send(input.threadId, {
        type: "prompt",
        ...(input.input === undefined ? {} : { message: input.input }),
      });
      if (isLocalOnlyPromptResponse(response)) {
        yield* this.#emitTurnCompleted(session);
      }
      return {
        threadId: input.threadId,
        turnId,
        resumeCursor: session.sessionFile,
      };
    });
  }

  public hasSession(threadId: ThreadId) {
    return Effect.succeed(this.#sessions.has(threadId));
  }

  public listSessions() {
    return Effect.succeed(Array.from(this.#sessions.values(), (session) => session.snapshot));
  }

  public stopSession(threadId: ThreadId) {
    return Effect.gen({ self: this }, function* () {
      const session = this.#sessions.get(threadId);
      if (!session) {
        return;
      }
      this.#sessions.delete(threadId);
      yield* this.runtime.dispose(threadId);
    });
  }

  public stopAll() {
    return Effect.gen({ self: this }, function* () {
      const threadIds = Array.from(this.#sessions.keys());
      this.#sessions.clear();
      yield* Effect.forEach(threadIds, (threadId) => this.runtime.dispose(threadId), {
        discard: true,
      });
    });
  }

  public interruptTurn(threadId: ThreadId, _turnId?: TurnId) {
    return Effect.gen({ self: this }, function* () {
      if (!this.#sessions.has(threadId)) {
        return yield* new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      yield* this.runtime.send(threadId, { type: "abort" });
    });
  }

  public readThread(threadId: ThreadId) {
    return Effect.gen({ self: this }, function* () {
      if (!this.#sessions.has(threadId)) {
        return yield* new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      return { threadId, turns: [] as const };
    });
  }

  public rollbackThread(threadId: ThreadId, _numTurns: number) {
    return Effect.gen({ self: this }, function* () {
      if (!this.#sessions.has(threadId)) {
        return yield* new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "rollbackThread",
        detail: "unsupported: omp branch rollback is not wired yet",
      });
    });
  }

  public respondToRequest(
    threadId: ThreadId,
    _requestId: ApprovalRequestId,
    _decision: ProviderApprovalDecision,
  ) {
    return Effect.gen({ self: this }, function* () {
      if (!this.#sessions.has(threadId)) {
        return yield* new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "respondToRequest",
        detail: "unsupported: extension_ui_request approval bridge is not wired yet",
      });
    });
  }

  public respondToUserInput(
    threadId: ThreadId,
    _requestId: ApprovalRequestId,
    _answers: ProviderUserInputAnswers,
  ) {
    return Effect.gen({ self: this }, function* () {
      if (!this.#sessions.has(threadId)) {
        return yield* new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "respondToUserInput",
        detail: "unsupported: extension_ui_request user-input bridge is not wired yet",
      });
    });
  }

  public discoverModels(threadId: ThreadId) {
    return Effect.gen({ self: this }, function* () {
      if (!this.#sessions.has(threadId)) {
        return yield* new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      const response = yield* this.runtime.send(threadId, { type: "get_available_models" });
      return yield* modelsFromAvailableModelsResponse(response);
    });
  }

  #onFrame(session: LiveAdapterSession, frame: object): Effect.Effect<void> {
    if (!isRecord(frame) || typeof frame.type !== "string") {
      return Effect.void;
    }
    if (frame.type === "agent_end" && frame.isTerminal !== false) {
      return this.#emitTurnCompleted(session);
    }
    if (frame.type === "prompt_result" && frame.agentInvoked === false) {
      return this.#emitTurnCompleted(session);
    }
    if (frame.type === "message_update") {
      return this.#onMessageUpdate(session, frame);
    }
    if (frame.type === "subagent_lifecycle") {
      return this.#onSubagentLifecycle(session, frame);
    }
    if (frame.type === "subagent_progress") {
      return this.#onSubagentProgress(session, frame);
    }
    return Effect.void;
  }

  #onSubagentLifecycle(
    session: LiveAdapterSession,
    frame: Record<string, unknown>,
  ): Effect.Effect<void> {
    const payload = frame.payload;
    if (!isRecord(payload) || typeof payload.id !== "string") {
      return Effect.void;
    }
    const taskId = RuntimeTaskId.make(payload.id);
    const role = typeof payload.agent === "string" ? payload.agent : undefined;
    const description =
      typeof payload.description === "string" && payload.description.length > 0
        ? payload.description
        : undefined;
    const toolUseId =
      typeof payload.parentToolCallId === "string" ? payload.parentToolCallId : undefined;
    const agentIndex = typeof payload.index === "number" ? payload.index : undefined;
    const linkage = {
      ...(role === undefined ? {} : { role }),
      ...(description === undefined ? {} : { title: description }),
      ...(toolUseId === undefined ? {} : { toolUseId }),
      ...(agentIndex === undefined ? {} : { agentIndex }),
    };
    if (payload.status === "started") {
      return this.#emit({
        type: "task.started",
        threadId: session.threadId,
        turnId: session.turnId,
        payload: {
          taskId,
          ...(description === undefined ? {} : { description }),
          ...linkage,
        },
      });
    }
    const status =
      payload.status === "completed"
        ? ("completed" as const)
        : payload.status === "failed"
          ? ("failed" as const)
          : payload.status === "aborted"
            ? ("stopped" as const)
            : undefined;
    if (status === undefined) {
      return Effect.void;
    }
    return this.#emit({
      type: "task.completed",
      threadId: session.threadId,
      turnId: session.turnId,
      payload: {
        taskId,
        status,
        ...linkage,
      },
    });
  }

  #onSubagentProgress(
    session: LiveAdapterSession,
    frame: Record<string, unknown>,
  ): Effect.Effect<void> {
    const payload = frame.payload;
    if (!isRecord(payload)) {
      return Effect.void;
    }
    const progress = payload.progress;
    if (!isRecord(progress) || typeof progress.id !== "string") {
      return Effect.void;
    }
    const description =
      (typeof progress.task === "string" && progress.task.length > 0 ? progress.task : undefined) ??
      (typeof payload.task === "string" && payload.task.length > 0 ? payload.task : undefined);
    if (description === undefined) {
      return Effect.void;
    }
    const role =
      typeof progress.agent === "string"
        ? progress.agent
        : typeof payload.agent === "string"
          ? payload.agent
          : undefined;
    const toolUseId =
      typeof payload.parentToolCallId === "string" ? payload.parentToolCallId : undefined;
    const lastToolName =
      typeof progress.currentTool === "string" ? progress.currentTool : undefined;
    const status = runtimeTaskStatusFromOmpProgress(progress.status);
    const agentIndex = typeof progress.index === "number" ? progress.index : undefined;
    return this.#emit({
      type: "task.progress",
      threadId: session.threadId,
      turnId: session.turnId,
      payload: {
        taskId: RuntimeTaskId.make(progress.id),
        description,
        ...(status === undefined ? {} : { status }),
        ...(lastToolName === undefined ? {} : { lastToolName }),
        ...(role === undefined ? {} : { role }),
        ...(toolUseId === undefined ? {} : { toolUseId }),
        ...(agentIndex === undefined ? {} : { agentIndex }),
      },
    });
  }

  #onMessageUpdate(
    session: LiveAdapterSession,
    frame: Record<string, unknown>,
  ): Effect.Effect<void> {
    const event = frame.assistantMessageEvent;
    if (!isRecord(event) || event.type !== "text_delta") {
      return Effect.void;
    }
    const delta = event.delta;
    if (typeof delta !== "string" || delta.length === 0) {
      return Effect.void;
    }
    return this.#emit({
      type: "content.delta",
      threadId: session.threadId,
      turnId: session.turnId,
      payload: {
        streamKind: "assistant_text",
        delta,
      },
    });
  }

  #emitTurnCompleted(session: LiveAdapterSession): Effect.Effect<void> {
    return this.#emit({
      type: "turn.completed",
      threadId: session.threadId,
      turnId: session.turnId,
      payload: { state: "completed" },
    });
  }

  #applyModelSelection(threadId: ThreadId, model: string | undefined) {
    return Effect.gen({ self: this }, function* () {
      if (model === undefined) {
        return;
      }
      const parsed = parseOmpModelSlug(model);
      if (!parsed) {
        yield* this.#clearLiveSession(threadId);
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "set_model",
          detail: `invalid omp model slug: ${model}`,
        });
      }
      const exit = yield* Effect.exit(
        this.runtime.send(threadId, {
          type: "set_model",
          provider: parsed.provider,
          modelId: parsed.modelId,
        }),
      );
      if (Exit.isFailure(exit)) {
        yield* this.#clearLiveSession(threadId);
        const cause = Cause.squash(exit.cause);
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "set_model",
          detail: cause instanceof Error ? cause.message : String(cause),
        });
      }
    });
  }

  #clearLiveSession(threadId: ThreadId) {
    return Effect.gen({ self: this }, function* () {
      this.#sessions.delete(threadId);
      yield* this.runtime.dispose(threadId);
    });
  }

  #emit(
    event: Omit<ProviderRuntimeEvent, "eventId" | "provider" | "createdAt"> & {
      readonly turnId?: TurnId | undefined;
    },
  ): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const createdAt = yield* nowIso;
      const { turnId, ...rest } = event;
      yield* Queue.offer(this.#events, {
        ...rest,
        eventId: EventId.make(globalThis.crypto.randomUUID()),
        provider: PROVIDER,
        createdAt,
        ...(turnId === undefined ? {} : { turnId }),
      } as ProviderRuntimeEvent);
    });
  }
}

function parseOmpModelSlug(slug: string): { provider: string; modelId: string } | null {
  const slash = slug.indexOf("/");
  if (slash <= 0 || slash === slug.length - 1) {
    return null;
  }
  return { provider: slug.slice(0, slash), modelId: slug.slice(slash + 1) };
}

function runtimeTaskStatusFromOmpProgress(status: unknown): RuntimeTaskStatus | undefined {
  switch (status) {
    case "pending":
    case "running":
    case "completed":
    case "failed":
      return status;
    case "aborted":
      return "cancelled";
    default:
      return undefined;
  }
}

function isLocalOnlyPromptResponse(response: object): boolean {
  return isRecord(response) && isRecord(response.data) && response.data.agentInvoked === false;
}

function modelsFromAvailableModelsResponse(
  response: object,
): Effect.Effect<ReadonlyArray<ServerProviderModel>, ProviderAdapterRequestError> {
  if (!isRecord(response) || !isRecord(response.data) || !Array.isArray(response.data.models)) {
    return Effect.fail(
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "get_available_models",
        detail: "response data.models must be an array",
      }),
    );
  }
  const models: ServerProviderModel[] = [];
  for (const entry of response.data.models) {
    if (!isRecord(entry) || typeof entry.provider !== "string" || typeof entry.id !== "string") {
      return Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "get_available_models",
          detail: "each model requires provider and id strings",
        }),
      );
    }
    const provider = entry.provider.trim();
    const id = entry.id.trim();
    const slug = `${provider}/${id}`;
    const name =
      typeof entry.name === "string" && entry.name.trim().length > 0 ? entry.name.trim() : slug;
    models.push({
      slug,
      name,
      isCustom: false,
      capabilities: null,
    });
  }
  return Effect.succeed(models);
}
