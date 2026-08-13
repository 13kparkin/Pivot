/**
 * OmpAdapter — maps omp RPC session frames onto ProviderRuntimeEvent.
 *
 * Turn completion (AC11): terminal `agent_end` (`isTerminal !== false`),
 * prompt `data.agentInvoked === false`, and `prompt_result` with
 * `agentInvoked: false`. Empty assistant deltas are not emitted (AC2).
 *
 * @module provider/omp/OmpAdapter
 */
import {
  EventId,
  type ProviderRuntimeEvent,
  type ProviderSessionStartInput,
  type ProviderSendTurnInput,
  ProviderDriverKind,
  type RuntimeMode,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { ProviderAdapterSessionNotFoundError, ProviderAdapterValidationError } from "../Errors.ts";
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
      const session: LiveAdapterSession = {
        threadId: input.threadId,
        sessionFile: handle.sessionFile,
        runtimeMode: input.runtimeMode,
        cwd,
        turnId: undefined,
      };
      this.#sessions.set(input.threadId, session);
      yield* this.runtime.streamFrames(input.threadId).pipe(
        Stream.runForEach((frame) => this.#onFrame(session, frame)),
        Effect.forkChild,
      );
      const createdAt = yield* nowIso;
      return {
        provider: PROVIDER,
        status: "ready" as const,
        runtimeMode: input.runtimeMode,
        cwd,
        threadId: input.threadId,
        resumeCursor: handle.sessionFile,
        createdAt,
        updatedAt: createdAt,
      };
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
    return Effect.void;
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

function isLocalOnlyPromptResponse(response: object): boolean {
  return isRecord(response) && isRecord(response.data) && response.data.agentInvoked === false;
}
