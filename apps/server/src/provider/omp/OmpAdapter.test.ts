import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import {
  ApprovalRequestId,
  type ProviderRuntimeEvent,
  ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { describe } from "vite-plus/test";

import { ProviderAdapterRequestError, ProviderAdapterSessionNotFoundError } from "../Errors.ts";
import { OmpAdapter } from "./OmpAdapter.ts";

class FakeOmpRpc {
  agentInvoked: boolean | undefined = true;
  sessionFile = "/tmp/omp-session.jsonl";
  availableModels: ReadonlyArray<object> = [];
  readonly sent: Array<Record<string, unknown>> = [];
  readonly frames = new Map<string, Queue.Queue<object>>();

  ensureSession(input: {
    readonly sessionKey: string;
    readonly cwd: string;
    readonly resumeCursor: string | null;
  }) {
    return Effect.gen({ self: this }, function* () {
      if (!this.frames.has(input.sessionKey)) {
        this.frames.set(input.sessionKey, yield* Queue.unbounded<object>());
      }
      return { sessionKey: input.sessionKey, sessionFile: this.sessionFile };
    });
  }

  send(_sessionKey: string, command: Record<string, unknown>) {
    this.sent.push(command);
    if (command.type === "get_available_models") {
      return Effect.succeed({
        type: "response",
        success: true,
        data: { models: this.availableModels },
      });
    }
    return Effect.succeed({
      type: "response",
      success: true,
      ...(this.agentInvoked === undefined ? {} : { data: { agentInvoked: this.agentInvoked } }),
    });
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
}

const THREAD_ID = ThreadId.make("thread-1");
const PROVIDER = ProviderDriverKind.make("omp");

const startInput = {
  threadId: THREAD_ID,
  provider: PROVIDER,
  cwd: "/proj",
  runtimeMode: "full-access" as const,
};

const collectUntilTurnCompleted = (stream: Stream.Stream<ProviderRuntimeEvent>) =>
  Stream.runCollect(stream.pipe(Stream.takeUntil((event) => event.type === "turn.completed"))).pipe(
    Effect.map((chunk) => Array.from(chunk)),
  );

describe("OmpAdapter", () => {
  it.effect("completes a T3 turn on terminal agent_end", () =>
    Effect.gen(function* () {
      const fake = new FakeOmpRpc();
      const adapter = new OmpAdapter(fake);
      const eventsFiber = yield* collectUntilTurnCompleted(adapter.streamEvents).pipe(
        Effect.forkChild,
      );
      yield* adapter.startSession(startInput);
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hi" });
      yield* fake.offer(THREAD_ID, { type: "agent_end", messages: [], isTerminal: true });
      const events = yield* Fiber.join(eventsFiber);
      const completed = events.filter((event) => event.type === "turn.completed");
      NodeAssert.equal(completed.length, 1);
      NodeAssert.equal(completed[0]?.payload.state, "completed");
      NodeAssert.equal(completed[0]?.threadId, THREAD_ID);
      NodeAssert.equal(completed[0]?.provider, PROVIDER);
    }),
  );

  it.effect("treats agent_end with omitted isTerminal as terminal", () =>
    Effect.gen(function* () {
      const fake = new FakeOmpRpc();
      const adapter = new OmpAdapter(fake);
      const eventsFiber = yield* collectUntilTurnCompleted(adapter.streamEvents).pipe(
        Effect.forkChild,
      );
      yield* adapter.startSession(startInput);
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hi" });
      yield* fake.offer(THREAD_ID, { type: "agent_end", messages: [] });
      const events = yield* Fiber.join(eventsFiber);
      NodeAssert.equal(events.filter((event) => event.type === "turn.completed").length, 1);
    }),
  );

  it.effect("does not complete a T3 turn on nonterminal agent_end", () =>
    Effect.gen(function* () {
      const fake = new FakeOmpRpc();
      const adapter = new OmpAdapter(fake);
      const eventsFiber = yield* collectUntilTurnCompleted(adapter.streamEvents).pipe(
        Effect.forkChild,
      );
      yield* adapter.startSession(startInput);
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hi" });
      yield* fake.offer(THREAD_ID, { type: "agent_end", messages: [], isTerminal: false });
      yield* fake.offer(THREAD_ID, {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "hi" },
        message: { role: "assistant", content: [] },
      });
      yield* fake.offer(THREAD_ID, { type: "agent_end", messages: [], isTerminal: true });
      const events = yield* Fiber.join(eventsFiber);
      NodeAssert.equal(events.filter((event) => event.type === "turn.completed").length, 1);
      NodeAssert.equal(
        events.some(
          (event) =>
            event.type === "content.delta" &&
            event.payload.streamKind === "assistant_text" &&
            event.payload.delta === "hi",
        ),
        true,
      );
    }),
  );

  it.effect("completes a local-only prompt when agentInvoked is false", () =>
    Effect.gen(function* () {
      const fake = new FakeOmpRpc();
      fake.agentInvoked = false;
      const adapter = new OmpAdapter(fake);
      const eventsFiber = yield* collectUntilTurnCompleted(adapter.streamEvents).pipe(
        Effect.forkChild,
      );
      yield* adapter.startSession(startInput);
      const result = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "/help" });
      const events = yield* Fiber.join(eventsFiber);
      NodeAssert.equal(result.threadId, THREAD_ID);
      NodeAssert.equal(result.resumeCursor, "/tmp/omp-session.jsonl");
      NodeAssert.equal(events.filter((event) => event.type === "turn.completed").length, 1);
      NodeAssert.equal(
        events.some((event) => event.type === "item.started"),
        false,
      );
    }),
  );

  it.effect("completes a local-only prompt from a later prompt_result frame", () =>
    Effect.gen(function* () {
      const fake = new FakeOmpRpc();
      fake.agentInvoked = undefined;
      const adapter = new OmpAdapter(fake);
      const eventsFiber = yield* collectUntilTurnCompleted(adapter.streamEvents).pipe(
        Effect.forkChild,
      );
      yield* adapter.startSession(startInput);
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "/help" });
      yield* fake.offer(THREAD_ID, { type: "prompt_result", id: "req_1", agentInvoked: false });
      const events = yield* Fiber.join(eventsFiber);
      NodeAssert.equal(events.filter((event) => event.type === "turn.completed").length, 1);
    }),
  );

  it.effect("does not emit empty assistant content for tool-only or empty deltas", () =>
    Effect.gen(function* () {
      const fake = new FakeOmpRpc();
      const adapter = new OmpAdapter(fake);
      const eventsFiber = yield* collectUntilTurnCompleted(adapter.streamEvents).pipe(
        Effect.forkChild,
      );
      yield* adapter.startSession(startInput);
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "run tools" });
      yield* fake.offer(THREAD_ID, {
        type: "message_update",
        assistantMessageEvent: { type: "toolcall_start" },
        message: { role: "assistant", content: [] },
      });
      yield* fake.offer(THREAD_ID, {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "" },
        message: { role: "assistant", content: [] },
      });
      yield* fake.offer(THREAD_ID, { type: "agent_end", messages: [], isTerminal: true });
      const events = yield* Fiber.join(eventsFiber);
      NodeAssert.equal(
        events.some((event) => event.type === "content.delta"),
        false,
      );
      NodeAssert.equal(
        events.some(
          (event) =>
            (event.type === "item.started" || event.type === "item.completed") &&
            event.payload.itemType === "assistant_message",
        ),
        false,
      );
      NodeAssert.equal(events.filter((event) => event.type === "turn.completed").length, 1);
    }),
  );

  it.effect("lists a started session and reports hasSession", () =>
    Effect.gen(function* () {
      const fake = new FakeOmpRpc();
      const adapter = new OmpAdapter(fake);
      NodeAssert.equal(yield* adapter.hasSession(THREAD_ID), false);
      const session = yield* adapter.startSession(startInput);
      NodeAssert.equal(yield* adapter.hasSession(THREAD_ID), true);
      const listed = yield* adapter.listSessions();
      NodeAssert.equal(listed.length, 1);
      NodeAssert.equal(listed[0]?.threadId, THREAD_ID);
      NodeAssert.equal(listed[0]?.resumeCursor, session.resumeCursor);
    }),
  );

  it.effect("stopSession disposes the live omp child and drops the session", () =>
    Effect.gen(function* () {
      const fake = new FakeOmpRpc();
      const adapter = new OmpAdapter(fake);
      yield* adapter.startSession(startInput);
      yield* adapter.stopSession(THREAD_ID);
      NodeAssert.deepEqual(fake.disposed, [THREAD_ID]);
      NodeAssert.equal(yield* adapter.hasSession(THREAD_ID), false);
      NodeAssert.deepEqual(yield* adapter.listSessions(), []);
    }),
  );

  it.effect("stopAll disposes every live omp session", () =>
    Effect.gen(function* () {
      const fake = new FakeOmpRpc();
      const adapter = new OmpAdapter(fake);
      const threadB = ThreadId.make("thread-2");
      yield* adapter.startSession(startInput);
      yield* adapter.startSession({
        ...startInput,
        threadId: threadB,
        cwd: "/proj-b",
      });
      yield* adapter.stopAll();
      NodeAssert.equal(fake.disposed.length, 2);
      NodeAssert.equal(yield* adapter.hasSession(THREAD_ID), false);
      NodeAssert.equal(yield* adapter.hasSession(threadB), false);
    }),
  );

  it.effect("interruptTurn sends omp abort for a live session", () =>
    Effect.gen(function* () {
      const fake = new FakeOmpRpc();
      const adapter = new OmpAdapter(fake);
      yield* adapter.startSession(startInput);
      yield* adapter.interruptTurn(THREAD_ID);
      NodeAssert.equal(fake.sent.at(-1)?.type, "abort");
    }),
  );

  it.effect("interruptTurn fails when the session is missing", () =>
    Effect.gen(function* () {
      const adapter = new OmpAdapter(new FakeOmpRpc());
      const exit = yield* Effect.exit(adapter.interruptTurn(THREAD_ID));
      NodeAssert.equal(Exit.isFailure(exit), true);
      if (Exit.isFailure(exit)) {
        NodeAssert.ok(Cause.squash(exit.cause) instanceof ProviderAdapterSessionNotFoundError);
      }
    }),
  );

  it.effect("readThread returns an empty turn list for a live session", () =>
    Effect.gen(function* () {
      const adapter = new OmpAdapter(new FakeOmpRpc());
      yield* adapter.startSession(startInput);
      const snapshot = yield* adapter.readThread(THREAD_ID);
      NodeAssert.deepEqual(snapshot, { threadId: THREAD_ID, turns: [] });
    }),
  );

  it.effect("rollbackThread fails as explicit unsupported", () =>
    Effect.gen(function* () {
      const adapter = new OmpAdapter(new FakeOmpRpc());
      yield* adapter.startSession(startInput);
      const exit = yield* Effect.exit(adapter.rollbackThread(THREAD_ID, 1));
      NodeAssert.equal(Exit.isFailure(exit), true);
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause);
        NodeAssert.ok(error instanceof ProviderAdapterRequestError);
        NodeAssert.match(error.detail, /unsupported/i);
      }
    }),
  );

  it.effect("respondToRequest fails as explicit unsupported until extension_ui_request", () =>
    Effect.gen(function* () {
      const adapter = new OmpAdapter(new FakeOmpRpc());
      yield* adapter.startSession(startInput);
      const exit = yield* Effect.exit(
        adapter.respondToRequest(THREAD_ID, ApprovalRequestId.make("req-1"), "accept"),
      );
      NodeAssert.equal(Exit.isFailure(exit), true);
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause);
        NodeAssert.ok(error instanceof ProviderAdapterRequestError);
        NodeAssert.match(error.detail, /unsupported/i);
      }
    }),
  );

  it.effect("respondToUserInput fails as explicit unsupported until extension_ui_request", () =>
    Effect.gen(function* () {
      const adapter = new OmpAdapter(new FakeOmpRpc());
      yield* adapter.startSession(startInput);
      const exit = yield* Effect.exit(
        adapter.respondToUserInput(THREAD_ID, ApprovalRequestId.make("req-1"), {}),
      );
      NodeAssert.equal(Exit.isFailure(exit), true);
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause);
        NodeAssert.ok(error instanceof ProviderAdapterRequestError);
        NodeAssert.match(error.detail, /unsupported/i);
      }
    }),
  );

  it.effect("discoverModels maps get_available_models into ServerProviderModel slugs", () =>
    Effect.gen(function* () {
      const fake = new FakeOmpRpc();
      fake.availableModels = [
        { provider: "openai", id: "gpt-5", name: "GPT-5" },
        { provider: "anthropic", id: "claude-sonnet-4", name: "Claude Sonnet 4" },
      ];
      const adapter = new OmpAdapter(fake);
      yield* adapter.startSession(startInput);
      const models = yield* adapter.discoverModels(THREAD_ID);
      NodeAssert.equal(fake.sent.at(-1)?.type, "get_available_models");
      NodeAssert.deepEqual(
        models.map((model) => ({ slug: model.slug, name: model.name, isCustom: model.isCustom })),
        [
          { slug: "openai/gpt-5", name: "GPT-5", isCustom: false },
          { slug: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4", isCustom: false },
        ],
      );
    }),
  );
});
