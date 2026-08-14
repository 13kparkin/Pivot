import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import {
  ApprovalRequestId,
  type ProviderRuntimeEvent,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { describe } from "vite-plus/test";

import { ProviderAdapterRequestError, ProviderAdapterSessionNotFoundError } from "../Errors.ts";
const isProviderAdapterSessionNotFoundError = Schema.is(ProviderAdapterSessionNotFoundError);
const isProviderAdapterRequestError = Schema.is(ProviderAdapterRequestError);
import { FakeOmpRpc } from "./FakeOmpRpc.ts";
import { OmpAdapter } from "./OmpAdapter.ts";

let nextTestUuid = 0;
const testRandomUUID = Effect.sync(() => {
  nextTestUuid += 1;
  return `00000000-0000-4000-8000-${String(nextTestUuid).padStart(12, "0")}`;
});

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
      const adapter = new OmpAdapter(fake, testRandomUUID);
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

  it.effect("sendTurn emits turn.started before prompt for checkpoint baseline", () =>
    Effect.gen(function* () {
      const fake = new FakeOmpRpc();
      const adapter = new OmpAdapter(fake, testRandomUUID);
      const eventsFiber = yield* Stream.runCollect(
        adapter.streamEvents.pipe(Stream.takeUntil((event) => event.type === "turn.started")),
      ).pipe(
        Effect.map((chunk) => Array.from(chunk)),
        Effect.forkChild,
      );
      yield* adapter.startSession(startInput);
      const result = yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hi" });
      const events = yield* Fiber.join(eventsFiber);
      const started = events.find((event) => event.type === "turn.started");
      NodeAssert.ok(started);
      NodeAssert.equal(started?.threadId, THREAD_ID);
      NodeAssert.equal(started?.turnId, result.turnId);
      NodeAssert.equal(started?.provider, PROVIDER);
      NodeAssert.equal(fake.sent.findIndex((command) => command.type === "prompt") >= 0, true);
    }),
  );

  it.effect("treats agent_end with omitted isTerminal as terminal", () =>
    Effect.gen(function* () {
      const fake = new FakeOmpRpc();
      const adapter = new OmpAdapter(fake, testRandomUUID);
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
      const adapter = new OmpAdapter(fake, testRandomUUID);
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
      const adapter = new OmpAdapter(fake, testRandomUUID);
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
      const adapter = new OmpAdapter(fake, testRandomUUID);
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

  it.effect("surfaces command_output text from local slash prompts as assistant_text", () =>
    Effect.gen(function* () {
      const fake = new FakeOmpRpc();
      fake.agentInvoked = undefined;
      const adapter = new OmpAdapter(fake, testRandomUUID);
      const eventsFiber = yield* collectUntilTurnCompleted(adapter.streamEvents).pipe(
        Effect.forkChild,
      );
      yield* adapter.startSession(startInput);
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "/jobs" });
      yield* fake.offer(THREAD_ID, {
        type: "command_output",
        text: "No background jobs running.",
      });
      yield* fake.offer(THREAD_ID, { type: "prompt_result", id: "req_1", agentInvoked: false });
      const events = yield* Fiber.join(eventsFiber);
      NodeAssert.equal(
        events.some(
          (event) =>
            event.type === "content.delta" &&
            event.payload.streamKind === "assistant_text" &&
            event.payload.delta === "No background jobs running.",
        ),
        true,
      );
      NodeAssert.equal(events.filter((event) => event.type === "turn.completed").length, 1);
    }),
  );

  it.effect("separates consecutive assistant messages with a paragraph break", () =>
    Effect.gen(function* () {
      const fake = new FakeOmpRpc();
      const adapter = new OmpAdapter(fake, testRandomUUID);
      const eventsFiber = yield* collectUntilTurnCompleted(adapter.streamEvents).pipe(
        Effect.forkChild,
      );
      yield* adapter.startSession(startInput);
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hi" });
      yield* fake.offer(THREAD_ID, {
        type: "message_start",
        message: { role: "assistant", content: [] },
      });
      yield* fake.offer(THREAD_ID, {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Fetching latest upstream." },
        message: { role: "assistant", content: [] },
      });
      yield* fake.offer(THREAD_ID, {
        type: "message_end",
        message: { role: "assistant", content: [] },
      });
      yield* fake.offer(THREAD_ID, {
        type: "message_start",
        message: { role: "assistant", content: [] },
      });
      yield* fake.offer(THREAD_ID, {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "24 commits behind." },
        message: { role: "assistant", content: [] },
      });
      yield* fake.offer(THREAD_ID, { type: "agent_end", messages: [], isTerminal: true });
      const events = yield* Fiber.join(eventsFiber);
      const deltas = events
        .filter(
          (event) =>
            event.type === "content.delta" && event.payload.streamKind === "assistant_text",
        )
        .map((event) => (event as { payload: { delta: string } }).payload.delta);
      NodeAssert.deepEqual(deltas, ["Fetching latest upstream.", "\n\n24 commits behind."]);
    }),
  );

  it.effect("tool-only assistant messages do not add paragraph breaks", () =>
    Effect.gen(function* () {
      const fake = new FakeOmpRpc();
      const adapter = new OmpAdapter(fake, testRandomUUID);
      const eventsFiber = yield* collectUntilTurnCompleted(adapter.streamEvents).pipe(
        Effect.forkChild,
      );
      yield* adapter.startSession(startInput);
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hi" });
      yield* fake.offer(THREAD_ID, {
        type: "message_start",
        message: { role: "assistant", content: [] },
      });
      yield* fake.offer(THREAD_ID, {
        type: "message_update",
        assistantMessageEvent: { type: "toolcall_start" },
        message: { role: "assistant", content: [] },
      });
      yield* fake.offer(THREAD_ID, {
        type: "message_start",
        message: { role: "assistant", content: [] },
      });
      yield* fake.offer(THREAD_ID, {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "first text" },
        message: { role: "assistant", content: [] },
      });
      yield* fake.offer(THREAD_ID, { type: "agent_end", messages: [], isTerminal: true });
      const events = yield* Fiber.join(eventsFiber);
      const deltas = events
        .filter(
          (event) =>
            event.type === "content.delta" && event.payload.streamKind === "assistant_text",
        )
        .map((event) => (event as { payload: { delta: string } }).payload.delta);
      NodeAssert.deepEqual(deltas, ["first text"]);
    }),
  );

  it.effect("ignores empty command_output text from local slash prompts", () =>
    Effect.gen(function* () {
      const fake = new FakeOmpRpc();
      fake.agentInvoked = undefined;
      const adapter = new OmpAdapter(fake, testRandomUUID);
      const eventsFiber = yield* collectUntilTurnCompleted(adapter.streamEvents).pipe(
        Effect.forkChild,
      );
      yield* adapter.startSession(startInput);
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "/jobs" });
      yield* fake.offer(THREAD_ID, { type: "command_output", text: "" });
      yield* fake.offer(THREAD_ID, { type: "prompt_result", id: "req_1", agentInvoked: false });
      const events = yield* Fiber.join(eventsFiber);
      NodeAssert.equal(
        events.some(
          (event) =>
            event.type === "content.delta" && event.payload.streamKind === "assistant_text",
        ),
        false,
      );
      NodeAssert.equal(events.filter((event) => event.type === "turn.completed").length, 1);
    }),
  );

  it.effect("does not emit empty assistant content for tool-only or empty deltas", () =>
    Effect.gen(function* () {
      const fake = new FakeOmpRpc();
      const adapter = new OmpAdapter(fake, testRandomUUID);
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
        events.some(
          (event) =>
            event.type === "content.delta" && event.payload.streamKind === "assistant_text",
        ),
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

  it.effect("maps toolcall_end and tool_execution frames to item lifecycle events", () =>
    Effect.gen(function* () {
      const fake = new FakeOmpRpc();
      const adapter = new OmpAdapter(fake, testRandomUUID);
      const eventsFiber = yield* collectUntilTurnCompleted(adapter.streamEvents).pipe(
        Effect.forkChild,
      );
      yield* adapter.startSession(startInput);
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "run bash" });
      yield* fake.offer(THREAD_ID, {
        type: "message_update",
        assistantMessageEvent: {
          type: "toolcall_end",
          toolCall: {
            type: "toolCall",
            id: "call_bash_1",
            name: "bash",
            arguments: { command: "git status" },
          },
        },
        message: { role: "assistant", content: [] },
      });
      yield* fake.offer(THREAD_ID, {
        type: "tool_execution_start",
        toolCallId: "call_bash_1",
        toolName: "bash",
        args: { command: "git status" },
      });
      yield* fake.offer(THREAD_ID, {
        type: "tool_execution_update",
        toolCallId: "call_bash_1",
        toolName: "bash",
        args: { command: "git status" },
        partialResult: {
          content: [{ type: "text", text: "M README.md\n" }],
        },
      });
      yield* fake.offer(THREAD_ID, {
        type: "tool_execution_end",
        toolCallId: "call_bash_1",
        toolName: "bash",
        result: {
          content: [{ type: "text", text: "M README.md\n" }],
        },
        isError: false,
      });
      yield* fake.offer(THREAD_ID, { type: "agent_end", messages: [], isTerminal: true });
      const events = yield* Fiber.join(eventsFiber);
      const started = events.find(
        (event) =>
          event.type === "item.started" &&
          event.payload.itemType === "command_execution" &&
          event.payload.title === "bash",
      );
      NodeAssert.ok(started);
      if (started?.type === "item.started") {
        NodeAssert.equal(started.payload.detail, "git status");
        NodeAssert.equal((started.payload.data as { command?: string }).command, "git status");
      }
      NodeAssert.equal(
        events.some(
          (event) =>
            event.type === "content.delta" &&
            event.payload.streamKind === "command_output" &&
            event.payload.delta === "M README.md\n",
        ),
        true,
      );
      const completed = events.find(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "command_execution",
      );
      NodeAssert.ok(completed);
      if (completed?.type === "item.completed") {
        NodeAssert.equal(completed.payload.status, "completed");
        NodeAssert.equal(completed.payload.detail, "git status");
      }
    }),
  );

  it.effect("maps read tool calls to path detail instead of raw result JSON", () =>
    Effect.gen(function* () {
      const fake = new FakeOmpRpc();
      const adapter = new OmpAdapter(fake, testRandomUUID);
      const eventsFiber = yield* collectUntilTurnCompleted(adapter.streamEvents).pipe(
        Effect.forkChild,
      );
      yield* adapter.startSession(startInput);
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "read file" });
      yield* fake.offer(THREAD_ID, {
        type: "tool_execution_start",
        toolCallId: "call_read_1",
        toolName: "read",
        args: { path: "/home/kyle/dev/Pivot/docs/user/install.md" },
      });
      yield* fake.offer(THREAD_ID, {
        type: "tool_execution_end",
        toolCallId: "call_read_1",
        toolName: "read",
        result: {
          content: [{ type: "text", text: "# Install\n\n..." }],
        },
        isError: false,
      });
      yield* fake.offer(THREAD_ID, { type: "agent_end", messages: [], isTerminal: true });
      const events = yield* Fiber.join(eventsFiber);
      const started = events.find(
        (event) => event.type === "item.started" && event.payload.title === "read",
      );
      NodeAssert.ok(started);
      if (started?.type === "item.started") {
        NodeAssert.equal(started.payload.itemType, "dynamic_tool_call");
        NodeAssert.equal(started.payload.detail, "/home/kyle/dev/Pivot/docs/user/install.md");
        NodeAssert.equal((started.payload.data as { kind?: string }).kind, "read");
      }
      const completed = events.find(
        (event) => event.type === "item.completed" && event.payload.title === "read",
      );
      NodeAssert.ok(completed);
      if (completed?.type === "item.completed") {
        NodeAssert.equal(completed.payload.detail, "/home/kyle/dev/Pivot/docs/user/install.md");
        NodeAssert.equal(completed.payload.detail?.includes('{"content"'), false);
      }
    }),
  );

  it.effect("maps thinking_delta to reasoning_text content deltas", () =>
    Effect.gen(function* () {
      const fake = new FakeOmpRpc();
      const adapter = new OmpAdapter(fake, testRandomUUID);
      const eventsFiber = yield* collectUntilTurnCompleted(adapter.streamEvents).pipe(
        Effect.forkChild,
      );
      yield* adapter.startSession(startInput);
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "think" });
      yield* fake.offer(THREAD_ID, {
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: "consider options" },
        message: { role: "assistant", content: [] },
      });
      yield* fake.offer(THREAD_ID, { type: "agent_end", messages: [], isTerminal: true });
      const events = yield* Fiber.join(eventsFiber);
      NodeAssert.equal(
        events.some(
          (event) =>
            event.type === "content.delta" &&
            event.payload.streamKind === "reasoning_text" &&
            event.payload.delta === "consider options",
        ),
        true,
      );
    }),
  );

  it.effect("emits thread token usage from get_state contextUsage on turn complete", () =>
    Effect.gen(function* () {
      const fake = new FakeOmpRpc();
      fake.contextUsage = { tokens: 1100, contextWindow: 200_000, percent: 55 };
      fake.tokensPerSecond = 42;
      fake.queuedMessageCount = 2;
      const adapter = new OmpAdapter(fake, testRandomUUID);
      const eventsFiber = yield* collectUntilTurnCompleted(adapter.streamEvents).pipe(
        Effect.forkChild,
      );
      yield* adapter.startSession(startInput);
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hi" });
      yield* fake.offer(THREAD_ID, { type: "agent_end", messages: [], isTerminal: true });
      const events = yield* Fiber.join(eventsFiber);
      NodeAssert.equal(
        events.some(
          (event) =>
            event.type === "thread.token-usage.updated" &&
            event.payload.usage.usedTokens === 1100 &&
            event.payload.usage.maxTokens === 200_000 &&
            event.payload.usage.contextUsedPercent === 55 &&
            event.payload.usage.tokensPerSecond === 42 &&
            event.payload.usage.queuedMessageCount === 2,
        ),
        true,
      );
      NodeAssert.equal(
        fake.sent.some((command) => command.type === "get_state"),
        true,
      );
    }),
  );

  it.effect("emits live thread token usage during message_update", () =>
    Effect.gen(function* () {
      const fake = new FakeOmpRpc();
      fake.contextUsage = { tokens: 500, contextWindow: 100_000, percent: 5 };
      fake.tokensPerSecond = 12.5;
      fake.queuedMessageCount = 1;
      const adapter = new OmpAdapter(fake, testRandomUUID);
      const eventsFiber = yield* Stream.runCollect(
        adapter.streamEvents.pipe(
          Stream.takeUntil(
            (event) =>
              event.type === "thread.token-usage.updated" &&
              event.payload.usage.tokensPerSecond === 12.5,
          ),
        ),
      ).pipe(
        Effect.map((chunk) => Array.from(chunk)),
        Effect.timeout("2 seconds"),
        Effect.forkChild,
      );
      yield* adapter.startSession(startInput);
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hi" });
      yield* fake.offer(THREAD_ID, {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "hello" },
      });
      const events = yield* Fiber.join(eventsFiber);
      NodeAssert.equal(
        events.some(
          (event) =>
            event.type === "thread.token-usage.updated" &&
            event.payload.usage.usedTokens === 500 &&
            event.payload.usage.contextUsedPercent === 5 &&
            event.payload.usage.tokensPerSecond === 12.5 &&
            event.payload.usage.queuedMessageCount === 1,
        ),
        true,
      );
    }),
  );

  it.effect("lists a started session and reports hasSession", () =>
    Effect.gen(function* () {
      const fake = new FakeOmpRpc();
      const adapter = new OmpAdapter(fake, testRandomUUID);
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
      const adapter = new OmpAdapter(fake, testRandomUUID);
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
      const adapter = new OmpAdapter(fake, testRandomUUID);
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
      const adapter = new OmpAdapter(fake, testRandomUUID);
      yield* adapter.startSession(startInput);
      yield* adapter.interruptTurn(THREAD_ID);
      NodeAssert.equal(fake.sent.at(-1)?.type, "abort");
    }),
  );

  it.effect("emits turn.aborted after interrupt when agent_end confirms the stop", () =>
    Effect.gen(function* () {
      const fake = new FakeOmpRpc();
      const adapter = new OmpAdapter(fake, testRandomUUID);
      const eventsFiber = yield* Stream.runCollect(
        adapter.streamEvents.pipe(
          Stream.takeUntil(
            (event) => event.type === "turn.aborted" || event.type === "turn.completed",
          ),
        ),
      ).pipe(
        Effect.map((chunk) => Array.from(chunk)),
        Effect.forkChild,
      );
      yield* adapter.startSession(startInput);
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hi" });
      yield* adapter.interruptTurn(THREAD_ID);
      yield* fake.offer(THREAD_ID, { type: "agent_end", messages: [], isTerminal: true });
      const events = yield* Fiber.join(eventsFiber);
      NodeAssert.equal(
        events.some(
          (event) => event.type === "turn.aborted" && event.payload.reason === "user_abort",
        ),
        true,
      );
      NodeAssert.equal(
        events.some((event) => event.type === "turn.completed"),
        false,
      );
    }),
  );

  it.effect("emits turn.completed when agent_end arrives without interrupt", () =>
    Effect.gen(function* () {
      const fake = new FakeOmpRpc();
      const adapter = new OmpAdapter(fake, testRandomUUID);
      const eventsFiber = yield* collectUntilTurnCompleted(adapter.streamEvents).pipe(
        Effect.forkChild,
      );
      yield* adapter.startSession(startInput);
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hi" });
      yield* fake.offer(THREAD_ID, { type: "agent_end", messages: [], isTerminal: true });
      const events = yield* Fiber.join(eventsFiber);
      NodeAssert.equal(
        events.some(
          (event) => event.type === "turn.completed" && event.payload.state === "completed",
        ),
        true,
      );
      NodeAssert.equal(
        events.some((event) => event.type === "turn.aborted"),
        false,
      );
    }),
  );

  it.effect("interruptTurn fails when the session is missing", () =>
    Effect.gen(function* () {
      const adapter = new OmpAdapter(new FakeOmpRpc(), testRandomUUID);
      const exit = yield* Effect.exit(adapter.interruptTurn(THREAD_ID));
      NodeAssert.equal(Exit.isFailure(exit), true);
      if (Exit.isFailure(exit)) {
        NodeAssert.ok(isProviderAdapterSessionNotFoundError(Cause.squash(exit.cause)));
      }
    }),
  );

  it.effect("settles turn + session when the frame transport ends mid-turn", () =>
    Effect.gen(function* () {
      const fake = new FakeOmpRpc();
      const adapter = new OmpAdapter(fake, testRandomUUID);
      const eventsFiber = yield* Stream.runCollect(
        adapter.streamEvents.pipe(Stream.takeUntil((event) => event.type === "session.exited")),
      ).pipe(
        Effect.map((chunk) => Array.from(chunk)),
        Effect.forkScoped,
      );
      yield* adapter.startSession(startInput);
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hi" });
      yield* fake.closeFrames(THREAD_ID);
      const events = yield* Fiber.join(eventsFiber);
      NodeAssert.equal(
        events.some(
          (event) => event.type === "turn.aborted" && event.payload.reason === "provider_exited",
        ),
        true,
      );
      NodeAssert.equal(
        events.some(
          (event) => event.type === "session.exited" && event.payload.exitKind === "error",
        ),
        true,
      );
      NodeAssert.equal(yield* adapter.hasSession(THREAD_ID), false);
      NodeAssert.deepEqual(fake.disposed, [THREAD_ID]);
    }).pipe(Effect.scoped),
  );

  it.effect("emits only session.exited when the transport ends while idle", () =>
    Effect.gen(function* () {
      const fake = new FakeOmpRpc();
      const adapter = new OmpAdapter(fake, testRandomUUID);
      const eventsFiber = yield* Stream.runCollect(
        adapter.streamEvents.pipe(Stream.takeUntil((event) => event.type === "session.exited")),
      ).pipe(
        Effect.map((chunk) => Array.from(chunk)),
        Effect.forkScoped,
      );
      yield* adapter.startSession(startInput);
      yield* fake.closeFrames(THREAD_ID);
      const events = yield* Fiber.join(eventsFiber);
      NodeAssert.equal(
        events.some((event) => event.type === "turn.aborted"),
        false,
      );
      NodeAssert.equal(
        events.some((event) => event.type === "session.exited"),
        true,
      );
      NodeAssert.equal(yield* adapter.hasSession(THREAD_ID), false);
    }).pipe(Effect.scoped),
  );

  it.effect("interruptTurn force-stops when abort is never acknowledged", () =>
    Effect.gen(function* () {
      const fake = new FakeOmpRpc();
      fake.respondToAbort = false;
      const adapter = new OmpAdapter(fake, testRandomUUID);
      const eventsFiber = yield* Stream.runCollect(
        adapter.streamEvents.pipe(Stream.takeUntil((event) => event.type === "session.exited")),
      ).pipe(
        Effect.map((chunk) => Array.from(chunk)),
        Effect.forkScoped,
      );
      yield* adapter.startSession(startInput);
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "hi" });
      const interruptFiber = yield* adapter.interruptTurn(THREAD_ID).pipe(Effect.forkScoped);
      yield* TestClock.adjust("10 seconds");
      yield* Fiber.join(interruptFiber);
      const events = yield* Fiber.join(eventsFiber);
      NodeAssert.equal(
        events.some(
          (event) => event.type === "turn.aborted" && event.payload.reason === "user_abort",
        ),
        true,
      );
      NodeAssert.equal(
        events.some((event) => event.type === "session.exited"),
        true,
      );
      NodeAssert.equal(yield* adapter.hasSession(THREAD_ID), false);
    }).pipe(Effect.scoped),
  );

  it.effect("readThread returns an empty turn list for a live session", () =>
    Effect.gen(function* () {
      const adapter = new OmpAdapter(new FakeOmpRpc(), testRandomUUID);
      yield* adapter.startSession(startInput);
      const snapshot = yield* adapter.readThread(THREAD_ID);
      NodeAssert.deepEqual(snapshot, { threadId: THREAD_ID, turns: [] });
    }),
  );

  it.effect("rollbackThread branches to the selected entryId", () =>
    Effect.gen(function* () {
      const fake = new FakeOmpRpc();
      fake.branchMessages = [
        { entryId: "e1", text: "first" },
        { entryId: "e2", text: "second" },
      ];
      const adapter = new OmpAdapter(fake, testRandomUUID);
      yield* adapter.startSession(startInput);
      const sentBefore = fake.sent.length;
      yield* adapter.rollbackThread(THREAD_ID, 1);
      const commands = fake.sent.slice(sentBefore).map((command) => command.type);
      NodeAssert.deepEqual(commands, ["get_branch_messages", "branch"]);
      NodeAssert.equal(fake.sent.at(-1)?.entryId, "e2");
    }),
  );

  it.effect("maps extension_ui_request confirm to request.opened and replies with confirmed", () =>
    Effect.gen(function* () {
      const fake = new FakeOmpRpc();
      const adapter = new OmpAdapter(fake, testRandomUUID);
      const eventsFiber = yield* Stream.runCollect(
        adapter.streamEvents.pipe(Stream.takeUntil((event) => event.type === "request.opened")),
      ).pipe(Effect.timeout("2 seconds"), Effect.forkChild);
      yield* adapter.startSession(startInput);
      yield* fake.offer(THREAD_ID, {
        type: "extension_ui_request",
        id: "ui-confirm-1",
        method: "confirm",
        title: "Allow bash?",
        message: "Run git status",
      });
      const events = yield* Fiber.join(eventsFiber);
      const opened = events.find((event) => event.type === "request.opened");
      NodeAssert.ok(opened);
      NodeAssert.equal(opened.requestId, "ui-confirm-1");
      NodeAssert.equal(opened.payload.requestType, "command_execution_approval");
      NodeAssert.match(String(opened.payload.detail ?? ""), /Allow bash/);

      yield* adapter.respondToRequest(THREAD_ID, ApprovalRequestId.make("ui-confirm-1"), "accept");
      const response = fake.sent.find((command) => command.type === "extension_ui_response");
      NodeAssert.deepEqual(response, {
        type: "extension_ui_response",
        id: "ui-confirm-1",
        confirmed: true,
      });
      yield* adapter.stopSession(THREAD_ID);
    }),
  );

  it.effect("maps extension_ui_request input to user-input.requested and replies with value", () =>
    Effect.gen(function* () {
      const fake = new FakeOmpRpc();
      const adapter = new OmpAdapter(fake, testRandomUUID);
      const eventsFiber = yield* Stream.runCollect(
        adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "user-input.requested"),
        ),
      ).pipe(Effect.timeout("2 seconds"), Effect.forkChild);
      yield* adapter.startSession(startInput);
      yield* fake.offer(THREAD_ID, {
        type: "extension_ui_request",
        id: "ui-input-1",
        method: "input",
        title: "Paste login code",
        placeholder: "one-time code",
      });
      const events = yield* Fiber.join(eventsFiber);
      const requested = events.find((event) => event.type === "user-input.requested");
      NodeAssert.ok(requested);
      NodeAssert.equal(requested.requestId, "ui-input-1");
      NodeAssert.equal(requested.payload.questions[0]?.header, "Paste login code");
      NodeAssert.equal(requested.payload.questions[0]?.options.length, 0);

      // Must not auto-cancel paste/input prompts.
      NodeAssert.equal(
        fake.sent.some(
          (command) => command.type === "extension_ui_response" && command.cancelled === true,
        ),
        false,
      );

      yield* adapter.respondToUserInput(THREAD_ID, ApprovalRequestId.make("ui-input-1"), {
        input: "abc-123",
      });
      const response = fake.sent.find((command) => command.type === "extension_ui_response");
      NodeAssert.deepEqual(response, {
        type: "extension_ui_response",
        id: "ui-input-1",
        value: "abc-123",
      });
      yield* adapter.stopSession(THREAD_ID);
    }),
  );

  it.effect("maps extension_ui_request select options into user-input questions", () =>
    Effect.gen(function* () {
      const fake = new FakeOmpRpc();
      const adapter = new OmpAdapter(fake, testRandomUUID);
      const eventsFiber = yield* Stream.runCollect(
        adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "user-input.requested"),
        ),
      ).pipe(Effect.timeout("2 seconds"), Effect.forkChild);
      yield* adapter.startSession(startInput);
      yield* fake.offer(THREAD_ID, {
        type: "extension_ui_request",
        id: "ui-select-1",
        method: "select",
        title: "Pick provider",
        options: ["openai", "anthropic"],
      });
      const events = yield* Fiber.join(eventsFiber);
      const requested = events.find((event) => event.type === "user-input.requested");
      NodeAssert.ok(requested);
      NodeAssert.deepEqual(
        requested.payload.questions[0]?.options.map((option) => option.label),
        ["openai", "anthropic"],
      );

      yield* adapter.respondToUserInput(THREAD_ID, ApprovalRequestId.make("ui-select-1"), {
        choice: "anthropic",
      });
      const response = fake.sent.find((command) => command.type === "extension_ui_response");
      NodeAssert.deepEqual(response, {
        type: "extension_ui_response",
        id: "ui-select-1",
        value: "anthropic",
      });
      yield* adapter.stopSession(THREAD_ID);
    }),
  );

  it.effect("respondToRequest without a pending confirm fails clearly", () =>
    Effect.gen(function* () {
      const adapter = new OmpAdapter(new FakeOmpRpc(), testRandomUUID);
      yield* adapter.startSession(startInput);
      const exit = yield* Effect.exit(
        adapter.respondToRequest(THREAD_ID, ApprovalRequestId.make("missing"), "accept"),
      );
      NodeAssert.equal(Exit.isFailure(exit), true);
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause);
        NodeAssert.ok(isProviderAdapterRequestError(error));
        NodeAssert.match(error.detail, /no pending/i);
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
      const adapter = new OmpAdapter(fake, testRandomUUID);
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

  it.effect(
    "discoverSlashCommands maps get_available_commands into ServerProviderSlashCommand",
    () =>
      Effect.gen(function* () {
        const fake = new FakeOmpRpc();
        fake.availableCommands = [
          { name: "model", description: "Switch model", input: { hint: "provider/model" } },
          { name: "review", description: "Review changes" },
          { name: "vibe", description: "Enter vibe mode" },
        ];
        const adapter = new OmpAdapter(fake, testRandomUUID);
        yield* adapter.startSession(startInput);
        const commands = yield* adapter.discoverSlashCommands(THREAD_ID);
        NodeAssert.equal(fake.sent.at(-1)?.type, "get_available_commands");
        NodeAssert.deepEqual(commands, [
          {
            name: "model",
            description: "Switch model",
            input: { hint: "provider/model" },
          },
          { name: "review", description: "Review changes" },
          { name: "vibe", description: "Enter vibe mode" },
        ]);
        yield* adapter.stopSession(THREAD_ID);
      }),
  );

  it.effect("listLoginProviders maps get_login_providers", () =>
    Effect.gen(function* () {
      const fake = new FakeOmpRpc();
      const adapter = new OmpAdapter(fake, testRandomUUID);
      yield* adapter.startSession(startInput);
      const providers = yield* adapter.listLoginProviders(THREAD_ID);
      NodeAssert.equal(fake.sent.at(-1)?.type, "get_login_providers");
      NodeAssert.deepEqual(providers, [
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
      ]);
    }),
  );

  it.effect("login sends omp login and returns providerId", () =>
    Effect.gen(function* () {
      const fake = new FakeOmpRpc();
      const adapter = new OmpAdapter(fake, testRandomUUID);
      yield* adapter.startSession(startInput);
      const result = yield* adapter.login(THREAD_ID, "anthropic", () => Effect.void);
      NodeAssert.equal(result.providerId, "anthropic");
      NodeAssert.equal(fake.sent.at(-1)?.type, "login");
      NodeAssert.equal(fake.sent.at(-1)?.providerId, "anthropic");
    }),
  );

  it.effect("sendTurn applies modelSelection via set_model before prompt", () =>
    Effect.gen(function* () {
      const fake = new FakeOmpRpc();
      const adapter = new OmpAdapter(fake, testRandomUUID);
      yield* adapter.startSession(startInput);
      const sentBeforeTurn = fake.sent.length;
      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hi",
        modelSelection: {
          instanceId: ProviderInstanceId.make("omp"),
          model: "openai/gpt-5",
        },
      });
      const turnCommands = fake.sent.slice(sentBeforeTurn);
      NodeAssert.deepEqual(
        turnCommands.map((command) => command.type),
        ["set_model", "prompt"],
      );
      NodeAssert.equal(turnCommands[0]?.provider, "openai");
      NodeAssert.equal(turnCommands[0]?.modelId, "gpt-5");
    }),
  );

  it.effect("sendTurn plan mode switches to the plan-role model then restores on default", () =>
    Effect.gen(function* () {
      const fake = new FakeOmpRpc();
      fake.stateModel = { provider: "openai", id: "gpt-5" };
      const adapter = new OmpAdapter(fake, testRandomUUID, {
        resolveRoleModel: (role) =>
          Effect.succeed(role === "plan" ? "anthropic/claude-plan" : undefined),
      });
      yield* adapter.startSession(startInput);

      const enterPlanFrom = fake.sent.length;
      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "design it",
        interactionMode: "plan",
      });
      const enterPlanCommands = fake.sent.slice(enterPlanFrom);
      NodeAssert.deepEqual(
        enterPlanCommands.map((command) => command.type),
        ["get_state", "set_model", "prompt"],
      );
      NodeAssert.equal(enterPlanCommands[1]?.provider, "anthropic");
      NodeAssert.equal(enterPlanCommands[1]?.modelId, "claude-plan");

      const exitPlanFrom = fake.sent.length;
      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "build it",
        interactionMode: "default",
      });
      const exitPlanCommands = fake.sent.slice(exitPlanFrom);
      NodeAssert.deepEqual(
        exitPlanCommands.map((command) => command.type),
        ["set_model", "prompt"],
      );
      NodeAssert.equal(exitPlanCommands[0]?.provider, "openai");
      NodeAssert.equal(exitPlanCommands[0]?.modelId, "gpt-5");
    }),
  );

  it.effect("sendTurn plan mode skips modelSelection while plan role is active", () =>
    Effect.gen(function* () {
      const fake = new FakeOmpRpc();
      fake.stateModel = { provider: "openai", id: "gpt-5" };
      const adapter = new OmpAdapter(fake, testRandomUUID, {
        resolveRoleModel: (role) =>
          Effect.succeed(role === "plan" ? "anthropic/claude-plan" : undefined),
      });
      yield* adapter.startSession(startInput);
      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "design it",
        interactionMode: "plan",
      });
      const stayingInPlanFrom = fake.sent.length;
      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "more plan",
        interactionMode: "plan",
        modelSelection: {
          instanceId: ProviderInstanceId.make("omp"),
          model: "openai/gpt-4o",
        },
      });
      const stayingInPlanCommands = fake.sent.slice(stayingInPlanFrom);
      NodeAssert.deepEqual(
        stayingInPlanCommands.map((command) => command.type),
        ["prompt"],
      );
    }),
  );

  it.effect("startSession applies modelSelection via set_model", () =>
    Effect.gen(function* () {
      const fake = new FakeOmpRpc();
      const adapter = new OmpAdapter(fake, testRandomUUID);
      yield* adapter.startSession({
        ...startInput,
        modelSelection: {
          instanceId: ProviderInstanceId.make("omp"),
          model: "anthropic/claude-sonnet-4",
        },
      });
      NodeAssert.equal(fake.sent.at(-1)?.type, "set_model");
      NodeAssert.equal(fake.sent.at(-1)?.provider, "anthropic");
      NodeAssert.equal(fake.sent.at(-1)?.modelId, "claude-sonnet-4");
    }),
  );

  it.effect("set_model failure disposes the live session for a clean retry", () =>
    Effect.gen(function* () {
      const fake = new FakeOmpRpc();
      fake.failSetModel = true;
      const adapter = new OmpAdapter(fake, testRandomUUID);
      yield* adapter.startSession(startInput);
      const exit = yield* Effect.exit(
        adapter.sendTurn({
          threadId: THREAD_ID,
          input: "hi",
          modelSelection: {
            instanceId: ProviderInstanceId.make("omp"),
            model: "openai/missing",
          },
        }),
      );
      NodeAssert.equal(Exit.isFailure(exit), true);
      NodeAssert.deepEqual(fake.disposed, [THREAD_ID]);
      NodeAssert.equal(yield* adapter.hasSession(THREAD_ID), false);
    }),
  );

  it.effect("startSession subscribes to omp subagent progress frames", () =>
    Effect.gen(function* () {
      const fake = new FakeOmpRpc();
      const adapter = new OmpAdapter(fake, testRandomUUID);
      yield* adapter.startSession(startInput);
      NodeAssert.equal(fake.sent[0]?.type, "set_subagent_subscription");
      NodeAssert.equal(fake.sent[0]?.level, "progress");
    }),
  );

  it.effect("maps subagent_lifecycle and subagent_progress into task.* events", () =>
    Effect.gen(function* () {
      const fake = new FakeOmpRpc();
      const adapter = new OmpAdapter(fake, testRandomUUID);
      const eventsFiber = yield* collectUntilTurnCompleted(adapter.streamEvents).pipe(
        Effect.forkChild,
      );
      yield* adapter.startSession(startInput);
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "spawn" });
      yield* fake.offer(THREAD_ID, {
        type: "subagent_lifecycle",
        payload: {
          id: "agent-1",
          agent: "scout",
          agentSource: "bundled",
          description: "survey repo",
          status: "started",
          parentToolCallId: "tool-9",
          index: 0,
        },
      });
      yield* fake.offer(THREAD_ID, {
        type: "subagent_progress",
        payload: {
          index: 0,
          agent: "scout",
          agentSource: "bundled",
          task: "survey repo",
          parentToolCallId: "tool-9",
          progress: {
            index: 0,
            id: "agent-1",
            agent: "scout",
            agentSource: "bundled",
            status: "running",
            task: "survey repo",
            currentTool: "read",
          },
        },
      });
      yield* fake.offer(THREAD_ID, {
        type: "subagent_lifecycle",
        payload: {
          id: "agent-1",
          agent: "scout",
          agentSource: "bundled",
          description: "survey repo",
          status: "completed",
          parentToolCallId: "tool-9",
          index: 0,
        },
      });
      yield* fake.offer(THREAD_ID, { type: "agent_end", messages: [], isTerminal: true });
      const events = yield* Fiber.join(eventsFiber);
      const started = events.find((event) => event.type === "task.started");
      const progress = events.find((event) => event.type === "task.progress");
      const completed = events.find((event) => event.type === "task.completed");
      NodeAssert.equal(started?.payload.taskId, RuntimeTaskId.make("agent-1"));
      NodeAssert.equal(started?.payload.description, "survey repo");
      NodeAssert.equal(started?.payload.role, "scout");
      NodeAssert.equal(started?.payload.toolUseId, "tool-9");
      NodeAssert.equal(started?.payload.agentIndex, 0);
      NodeAssert.equal(progress?.payload.taskId, RuntimeTaskId.make("agent-1"));
      NodeAssert.equal(progress?.payload.description, "survey repo");
      NodeAssert.equal(progress?.payload.lastToolName, "read");
      NodeAssert.equal(progress?.payload.status, "running");
      NodeAssert.equal(completed?.payload.taskId, RuntimeTaskId.make("agent-1"));
      NodeAssert.equal(completed?.payload.status, "completed");
    }),
  );

  it.effect("maps aborted subagent_lifecycle to task.completed stopped", () =>
    Effect.gen(function* () {
      const fake = new FakeOmpRpc();
      const adapter = new OmpAdapter(fake, testRandomUUID);
      const eventsFiber = yield* collectUntilTurnCompleted(adapter.streamEvents).pipe(
        Effect.forkChild,
      );
      yield* adapter.startSession(startInput);
      yield* adapter.sendTurn({ threadId: THREAD_ID, input: "spawn" });
      yield* fake.offer(THREAD_ID, {
        type: "subagent_lifecycle",
        payload: {
          id: "agent-2",
          agent: "scout",
          agentSource: "bundled",
          status: "aborted",
          index: 1,
        },
      });
      yield* fake.offer(THREAD_ID, { type: "agent_end", messages: [], isTerminal: true });
      const events = yield* Fiber.join(eventsFiber);
      const completed = events.find((event) => event.type === "task.completed");
      NodeAssert.equal(completed?.payload.taskId, RuntimeTaskId.make("agent-2"));
      NodeAssert.equal(completed?.payload.status, "stopped");
    }),
  );

  it.effect("fetchSubagentTranscript sends get_subagent_messages", () =>
    Effect.gen(function* () {
      const fake = new FakeOmpRpc();
      fake.subagentMessages = {
        sessionFile: "/tmp/sub.jsonl",
        fromByte: 0,
        nextByte: 42,
        reset: false,
        messages: [{ role: "assistant", content: "nested" }],
      };
      const adapter = new OmpAdapter(fake, testRandomUUID);
      yield* adapter.startSession(startInput);
      const sentBefore = fake.sent.length;
      const page = yield* adapter.fetchSubagentTranscript(THREAD_ID, "agent-1", 10);
      NodeAssert.deepEqual(
        fake.sent.slice(sentBefore).map((command) => command.type),
        ["get_subagent_messages"],
      );
      NodeAssert.equal(fake.sent.at(-1)?.subagentId, "agent-1");
      NodeAssert.equal(fake.sent.at(-1)?.fromByte, 10);
      NodeAssert.equal(page.sessionFile, "/tmp/sub.jsonl");
      NodeAssert.equal(page.nextByte, 42);
      NodeAssert.equal(page.messages.length, 1);
    }),
  );

  it.effect("steerSession sends steer", () =>
    Effect.gen(function* () {
      const fake = new FakeOmpRpc();
      const adapter = new OmpAdapter(fake, testRandomUUID);
      yield* adapter.startSession(startInput);
      const sentBefore = fake.sent.length;
      yield* adapter.steerSession(THREAD_ID, "focus on tests");
      NodeAssert.deepEqual(
        fake.sent.slice(sentBefore).map((command) => command.type),
        ["steer"],
      );
      NodeAssert.equal(fake.sent.at(-1)?.message, "focus on tests");
    }),
  );

  it.effect("setSubagentSubscription sends set_subagent_subscription", () =>
    Effect.gen(function* () {
      const fake = new FakeOmpRpc();
      const adapter = new OmpAdapter(fake, testRandomUUID);
      yield* adapter.startSession(startInput);
      const sentBefore = fake.sent.length;
      yield* adapter.setSubagentSubscription(THREAD_ID, "events");
      NodeAssert.deepEqual(
        fake.sent.slice(sentBefore).map((command) => command.type),
        ["set_subagent_subscription"],
      );
      NodeAssert.equal(fake.sent.at(-1)?.level, "events");
    }),
  );

  it.effect("sendTurn applies thinking and fastMode options before prompt", () =>
    Effect.gen(function* () {
      const fake = new FakeOmpRpc();
      const adapter = new OmpAdapter(fake, testRandomUUID);
      yield* adapter.startSession(startInput);
      const sentBefore = fake.sent.length;
      yield* adapter.sendTurn({
        threadId: THREAD_ID,
        input: "hi",
        modelSelection: {
          instanceId: ProviderInstanceId.make("omp"),
          model: "openai/gpt-5",
          options: [
            { id: "effort", value: "high" },
            { id: "fastMode", value: true },
          ],
        },
      });
      NodeAssert.deepEqual(
        fake.sent.slice(sentBefore).map((command) => command.type),
        ["set_model", "set_thinking_level", "set_fast_mode", "prompt"],
      );
      NodeAssert.equal(fake.sent.slice(sentBefore)[1]?.level, "high");
      NodeAssert.equal(fake.sent.slice(sentBefore)[2]?.enabled, true);
    }),
  );

  it.effect("compact and auto toggles send omp RPC", () =>
    Effect.gen(function* () {
      const fake = new FakeOmpRpc();
      const adapter = new OmpAdapter(fake, testRandomUUID);
      yield* adapter.startSession(startInput);
      const sentBefore = fake.sent.length;
      yield* adapter.setAutoCompaction(THREAD_ID, true);
      yield* adapter.setAutoRetry(THREAD_ID, false);
      yield* adapter.compact(THREAD_ID, "keep tests");
      NodeAssert.deepEqual(
        fake.sent.slice(sentBefore).map((command) => command.type),
        ["set_auto_compaction", "set_auto_retry", "compact"],
      );
    }),
  );

  it.effect("maps host_uri_request write to request.opened and accepts via host_uri_result", () =>
    Effect.gen(function* () {
      const fake = new FakeOmpRpc();
      const adapter = new OmpAdapter(fake, testRandomUUID);
      const eventsFiber = yield* Stream.runCollect(
        adapter.streamEvents.pipe(Stream.takeUntil((event) => event.type === "request.opened")),
      ).pipe(Effect.timeout("2 seconds"), Effect.forkChild);
      yield* adapter.startSession(startInput);
      yield* fake.offer(THREAD_ID, {
        type: "host_uri_request",
        id: "uri-1",
        operation: "write",
        url: "edit://file.ts",
        content: "new",
      });
      const events = yield* Fiber.join(eventsFiber);
      const opened = events.find((event) => event.type === "request.opened");
      NodeAssert.ok(opened);
      NodeAssert.equal(opened?.payload.requestType, "file_change_approval");
      yield* adapter.respondToRequest(THREAD_ID, ApprovalRequestId.make("uri-1"), "accept");
      const result = fake.sent.find((command) => command.type === "host_uri_result");
      NodeAssert.equal(result?.id, "uri-1");
      NodeAssert.equal(result?.isError, undefined);
    }),
  );
});
