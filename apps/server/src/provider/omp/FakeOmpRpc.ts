/**
 * In-memory omp RPC client for adapter / ProviderService tests.
 *
 * @module FakeOmpRpc
 */
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { OmpSpawnError } from "./OmpRpcRuntime.ts";

export class FakeOmpRpc {
  agentInvoked: boolean | undefined = true;
  failSetModel = false;
  /** When false, `send` never answers `abort` (simulates a wedged child). */
  respondToAbort = true;
  /** When true, `cancel_subagent` responds as an unknown command (pre-`cancel_subagent` omp). */
  cancelSubagentUnknown = false;
  /** When set, `get_state` responses are held until this resolves (throttle-race tests). */
  getStateGate: Deferred.Deferred<void> | undefined = undefined;
  sessionFile = "/tmp/omp-session.jsonl";
  availableModels: ReadonlyArray<object> = [];
  availableCommands: ReadonlyArray<object> = [];
  stateModel:
    | {
        readonly provider: string;
        readonly id: string;
      }
    | undefined = undefined;
  contextUsage:
    | {
        readonly tokens: number;
        readonly contextWindow?: number;
        readonly percent?: number;
      }
    | undefined = undefined;
  tokensPerSecond: number | undefined = undefined;
  queuedMessageCount: number | undefined = undefined;
  subagentMessages:
    | {
        readonly sessionFile: string;
        readonly fromByte: number;
        readonly nextByte: number;
        readonly reset: boolean;
        readonly messages: ReadonlyArray<object>;
      }
    | undefined = undefined;
  branchMessages: ReadonlyArray<{ readonly entryId: string; readonly text?: string }> = [];
  sessionStats:
    | {
        readonly tokens?: { readonly input?: number; readonly output?: number };
        readonly toolUses?: number;
        readonly durationMs?: number;
      }
    | undefined = undefined;
  readonly sent: Array<Record<string, unknown>> = [];
  readonly frames = new Map<string, Queue.Queue<object>>();

  ensureSession(input: {
    readonly sessionKey: string;
    readonly cwd: string;
    readonly resumeCursor: string | null;
    readonly extraEnv?: Record<string, string>;
  }): Effect.Effect<{ sessionKey: string; sessionFile: string }, OmpSpawnError> {
    return Effect.gen({ self: this }, function* () {
      if (!this.frames.has(input.sessionKey)) {
        this.frames.set(input.sessionKey, yield* Queue.unbounded<object>());
      }
      return { sessionKey: input.sessionKey, sessionFile: this.sessionFile };
    });
  }

  send(_sessionKey: string, command: Record<string, unknown>) {
    this.sent.push(command);
    if (command.type === "set_model") {
      if (this.failSetModel) {
        return Effect.fail(
          new OmpSpawnError({ operation: "set_model", detail: "set_model failed" }),
        );
      }
      if (typeof command.provider === "string" && typeof command.modelId === "string") {
        this.stateModel = { provider: command.provider, id: command.modelId };
      }
      return Effect.succeed({ type: "response", success: true, data: this.stateModel ?? {} });
    }
    if (command.type === "get_available_models") {
      return Effect.succeed({
        type: "response",
        success: true,
        data: { models: this.availableModels },
      });
    }
    if (command.type === "get_available_commands") {
      return Effect.succeed({
        type: "response",
        success: true,
        data: { commands: this.availableCommands },
      });
    }
    if (command.type === "get_login_providers") {
      return Effect.succeed({
        type: "response",
        success: true,
        data: {
          providers: [
            {
              id: "openai-codex",
              name: "ChatGPT Plus/Pro",
              available: true,
              authenticated: true,
            },
            {
              id: "anthropic",
              name: "Anthropic",
              available: true,
              authenticated: false,
            },
          ],
        },
      });
    }
    if (command.type === "login") {
      return Effect.succeed({
        type: "response",
        success: true,
        data: { providerId: command.providerId },
      });
    }
    if (command.type === "get_state") {
      const response = {
        type: "response",
        success: true,
        data: {
          sessionFile: this.sessionFile,
          ...(this.stateModel === undefined ? {} : { model: this.stateModel }),
          ...(this.contextUsage === undefined ? {} : { contextUsage: this.contextUsage }),
          ...(this.tokensPerSecond === undefined ? {} : { tokensPerSecond: this.tokensPerSecond }),
          ...(this.queuedMessageCount === undefined
            ? {}
            : { queuedMessageCount: this.queuedMessageCount }),
        },
      };
      return this.getStateGate === undefined
        ? Effect.succeed(response)
        : Deferred.await(this.getStateGate).pipe(Effect.as(response));
    }
    if (command.type === "get_subagent_messages") {
      return Effect.succeed({
        type: "response",
        success: true,
        data: this.subagentMessages ?? {
          sessionFile: "/tmp/sub.jsonl",
          fromByte: 0,
          nextByte: 0,
          reset: false,
          messages: [],
        },
      });
    }
    if (command.type === "get_branch_messages") {
      return Effect.succeed({
        type: "response",
        success: true,
        data: { messages: this.branchMessages },
      });
    }
    if (command.type === "get_session_stats") {
      return Effect.succeed({
        type: "response",
        success: true,
        data: this.sessionStats ?? {},
      });
    }
    if (command.type === "abort") {
      if (!this.respondToAbort) {
        return Effect.never;
      }
      return Effect.succeed({ type: "response", success: true, data: {} });
    }
    if (command.type === "cancel_subagent") {
      if (this.cancelSubagentUnknown) {
        return Effect.succeed({
          type: "response",
          command: "cancel_subagent",
          success: false,
          error: "Unknown command",
        });
      }
      return Effect.succeed({ type: "response", success: true, data: {} });
    }
    if (
      command.type === "steer" ||
      command.type === "set_subagent_subscription" ||
      command.type === "set_thinking_level" ||
      command.type === "set_fast_mode" ||
      command.type === "set_auto_compaction" ||
      command.type === "set_auto_retry" ||
      command.type === "compact" ||
      command.type === "branch" ||
      command.type === "set_host_uri_schemes"
    ) {
      return Effect.succeed({ type: "response", success: true, data: {} });
    }
    return Effect.succeed({
      type: "response",
      success: true,
      ...(this.agentInvoked === undefined ? {} : { data: { agentInvoked: this.agentInvoked } }),
    });
  }

  write(_sessionKey: string, command: Record<string, unknown>) {
    this.sent.push(command);
    return Effect.void;
  }

  streamFrames(sessionKey: string) {
    const queue = this.frames.get(sessionKey);
    if (!queue) {
      return Stream.die(`no live omp session for ${sessionKey}`);
    }
    return Stream.fromQueue(queue);
  }

  readonly disposed: string[] = [];

  dispose(sessionKey: string) {
    this.disposed.push(sessionKey);
    return Effect.void;
  }

  offer(sessionKey: string, frame: object) {
    const queue = this.frames.get(sessionKey);
    if (!queue) {
      return Effect.die(`no live omp session for ${sessionKey}`);
    }
    return Queue.offer(queue, frame);
  }

  /** End the frame stream for a session, simulating child exit / transport end. */
  closeFrames(sessionKey: string) {
    const queue = this.frames.get(sessionKey);
    if (!queue) {
      return Effect.void;
    }
    return Queue.shutdown(queue);
  }
}
