import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { OmpSettings, ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { describe } from "vite-plus/test";

import { makeOmpTextGeneration } from "./OmpTextGeneration.ts";

const decodeOmpSettings = Schema.decodeSync(OmpSettings);
const isTextGenerationError = Schema.is(TextGenerationError);
const UnknownJson = Schema.fromJsonString(Schema.Unknown);
const decodeUnknownJson = Schema.decodeSync(UnknownJson);
const encodeUnknownJson = Schema.encodeSync(UnknownJson);

const TITLE_JSON = '{"title":"Wire Omp Thread Titles"}';
const TITLE_MODEL = createModelSelection(ProviderInstanceId.make("omp"), "openai/gpt-5", [
  { id: "reasoningEffort", value: "low" },
]);
const BARE_LUNA_MODEL = createModelSelection(ProviderInstanceId.make("omp"), "gpt-5.6-luna", [
  { id: "reasoningEffort", value: "low" },
]);
const OMP_CATALOG = [
  { provider: "openai", id: "gpt-5" },
  { provider: "openai", id: "gpt-5.6-luna" },
  { provider: "openai-codex", id: "gpt-5.6-luna" },
  { provider: "deepinfra", id: "deepseek-ai/DeepSeek-V4-Flash-0731" },
];
const PROVIDER_ERROR_MESSAGE =
  "401 User is not authorized to access this resource (type=invalid_request_error param=invalid_api_key)";

function asSpawnedCommand(command: ChildProcess.Command) {
  if (command._tag !== "StandardCommand") {
    throw new Error("expected StandardCommand");
  }
  return {
    command: command.command,
    args: command.args,
    options: command.options,
  };
}

type PromptScript =
  | "text_delta"
  | "thinking_delta"
  | "thinking_content"
  | "message_end"
  | "last_assistant_text"
  | "confirm_then_text"
  | "select_then_text"
  | "provider_error"
  | "empty";

function makeFakeOmpSpawner(sessionFile: string, script: PromptScript = "text_delta") {
  const prompts: string[] = [];
  const setModels: Array<{ provider: string; modelId: string }> = [];
  const thinkingLevels: string[] = [];
  const uiResponses: Array<Record<string, unknown>> = [];
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const stdout = yield* Queue.unbounded<Uint8Array>();
      const offer = (frame: unknown) =>
        Queue.offer(stdout, encoder.encode(`${encodeUnknownJson(frame)}\n`));
      yield* offer({
        type: "ready",
        protocolVersion: 1,
        supportedProtocolVersions: [1, 2],
      });
      const spawned = asSpawnedCommand(command);
      // `omp --help` capability probes are plain CLI, not RPC.
      if (spawned.args.includes("--help")) {
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(encoder.encode("Usage: omp [options] --mode text|json|rpc|rpc-ui\n")),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }
      const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode, never>();
      let stdinBuf = "";
      const offerAssistantEnd = (frames: ReadonlyArray<unknown>) =>
        Effect.gen(function* () {
          for (const frame of frames) {
            yield* offer(frame);
          }
        });
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Deferred.await(exit),
        isRunning: Effect.succeed(true),
        kill: () => Deferred.succeed(exit, ChildProcessSpawner.ExitCode(143)).pipe(Effect.asVoid),
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((chunk: Uint8Array) => {
          stdinBuf += decoder.decode(chunk, { stream: true });
          return Effect.gen(function* () {
            let newlineIndex = stdinBuf.indexOf("\n");
            while (newlineIndex >= 0) {
              const line = stdinBuf.slice(0, newlineIndex).trim();
              stdinBuf = stdinBuf.slice(newlineIndex + 1);
              if (line.length > 0) {
                const rpcCommand = decodeUnknownJson(line) as Record<string, unknown>;
                if (rpcCommand.type === "negotiate_protocol") {
                  yield* offer({
                    id: rpcCommand.id,
                    type: "response",
                    command: "negotiate_protocol",
                    success: true,
                    data: { protocolVersion: 2 },
                  });
                } else if (rpcCommand.type === "get_state") {
                  yield* offer({
                    id: rpcCommand.id,
                    type: "response",
                    command: "get_state",
                    success: true,
                    data: { sessionFile },
                  });
                } else if (rpcCommand.type === "get_available_models") {
                  yield* offer({
                    id: rpcCommand.id,
                    type: "response",
                    command: "get_available_models",
                    success: true,
                    data: { models: OMP_CATALOG },
                  });
                } else if (rpcCommand.type === "get_last_assistant_text") {
                  yield* offer({
                    id: rpcCommand.id,
                    type: "response",
                    command: "get_last_assistant_text",
                    success: true,
                    data: { text: script === "last_assistant_text" ? TITLE_JSON : "" },
                  });
                } else if (rpcCommand.type === "set_model") {
                  setModels.push({
                    provider: String(rpcCommand.provider),
                    modelId: String(rpcCommand.modelId),
                  });
                  yield* offer({
                    id: rpcCommand.id,
                    type: "response",
                    command: "set_model",
                    success: true,
                  });
                } else if (rpcCommand.type === "set_thinking_level") {
                  thinkingLevels.push(String(rpcCommand.level));
                  yield* offer({
                    id: rpcCommand.id,
                    type: "response",
                    command: "set_thinking_level",
                    success: true,
                  });
                } else if (rpcCommand.type === "extension_ui_response") {
                  uiResponses.push(rpcCommand);
                  if (script === "confirm_then_text" && rpcCommand.confirmed === true) {
                    yield* offerAssistantEnd([
                      {
                        type: "message_update",
                        assistantMessageEvent: {
                          type: "text_delta",
                          delta: TITLE_JSON,
                        },
                      },
                      {
                        type: "agent_end",
                        isTerminal: true,
                      },
                    ]);
                  } else if (
                    script === "select_then_text" &&
                    typeof rpcCommand.value === "string"
                  ) {
                    yield* offerAssistantEnd([
                      {
                        type: "message_update",
                        assistantMessageEvent: {
                          type: "text_delta",
                          delta: TITLE_JSON,
                        },
                      },
                      {
                        type: "agent_end",
                        isTerminal: true,
                      },
                    ]);
                  } else if (script === "confirm_then_text" || script === "select_then_text") {
                    yield* offer({ type: "agent_end", isTerminal: true });
                  }
                } else if (rpcCommand.type === "prompt") {
                  prompts.push(typeof rpcCommand.message === "string" ? rpcCommand.message : "");
                  yield* offer({
                    id: rpcCommand.id,
                    type: "response",
                    command: "prompt",
                    success: true,
                    data: { agentInvoked: true },
                  });
                  if (script === "text_delta") {
                    yield* offerAssistantEnd([
                      {
                        type: "message_update",
                        assistantMessageEvent: {
                          type: "text_delta",
                          delta: TITLE_JSON,
                        },
                      },
                      {
                        type: "agent_end",
                        isTerminal: true,
                      },
                    ]);
                  } else if (script === "thinking_delta") {
                    yield* offerAssistantEnd([
                      {
                        type: "message_update",
                        assistantMessageEvent: {
                          type: "thinking_delta",
                          delta: TITLE_JSON,
                        },
                      },
                      {
                        type: "agent_end",
                        isTerminal: true,
                      },
                    ]);
                  } else if (script === "thinking_content") {
                    yield* offerAssistantEnd([
                      {
                        type: "message_end",
                        message: {
                          role: "assistant",
                          content: [{ type: "thinking", thinking: TITLE_JSON }],
                        },
                      },
                      {
                        type: "agent_end",
                        isTerminal: true,
                      },
                    ]);
                  } else if (script === "message_end") {
                    yield* offerAssistantEnd([
                      {
                        type: "message_end",
                        message: {
                          role: "assistant",
                          content: [{ type: "text", text: TITLE_JSON }],
                        },
                      },
                      {
                        type: "agent_end",
                        isTerminal: true,
                      },
                    ]);
                  } else if (script === "confirm_then_text") {
                    yield* offer({
                      type: "extension_ui_request",
                      id: "ui-confirm-1",
                      method: "confirm",
                      title: "Allow workspace?",
                      message: "Run in /proj",
                    });
                  } else if (script === "select_then_text") {
                    yield* offer({
                      type: "extension_ui_request",
                      id: "ui-select-1",
                      method: "select",
                      title: "Pick provider",
                      options: ["openai-codex", "openai"],
                    });
                  } else if (script === "provider_error") {
                    yield* offerAssistantEnd([
                      {
                        type: "message_end",
                        message: {
                          role: "assistant",
                          stopReason: "error",
                          errorMessage: PROVIDER_ERROR_MESSAGE,
                          content: [],
                        },
                      },
                      {
                        type: "agent_end",
                        isTerminal: true,
                      },
                    ]);
                  } else {
                    yield* offer({ type: "agent_end", isTerminal: true });
                  }
                } else {
                  yield* offer({
                    id: rpcCommand.id,
                    type: "response",
                    command: String(rpcCommand.type),
                    success: true,
                  });
                }
              }
              newlineIndex = stdinBuf.indexOf("\n");
            }
          });
        }),
        stdout: Stream.fromQueue(stdout),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { spawner, prompts, setModels, thinkingLevels, uiResponses };
}

function makeTextGeneration(fake: ReturnType<typeof makeFakeOmpSpawner>) {
  return makeOmpTextGeneration(
    decodeOmpSettings({
      enabled: true,
      binaryPath: "/opt/omp",
    }),
  ).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
    Effect.provide(NodeServices.layer),
  );
}

describe("OmpTextGeneration", () => {
  it.effect("generateThreadTitle collects text_delta JSON and sanitizes the title", () =>
    Effect.gen(function* () {
      const fake = makeFakeOmpSpawner("/tmp/omp-textgen.jsonl");
      const textGeneration = yield* makeTextGeneration(fake);

      const result = yield* textGeneration.generateThreadTitle({
        cwd: "/proj",
        message: "Please wire omp text generation so thread titles work again",
        modelSelection: TITLE_MODEL,
      });

      NodeAssert.equal(result.title, "Wire Omp Thread Titles");
      NodeAssert.equal(fake.setModels.length, 1);
      NodeAssert.deepEqual(fake.setModels[0], { provider: "openai", modelId: "gpt-5" });
      NodeAssert.deepEqual(fake.thinkingLevels, ["low"]);
      NodeAssert.ok(fake.prompts[0]?.includes("Generate a title"));
    }),
  );

  it.effect("generateThreadTitle resolves a bare model id against the omp catalog", () =>
    Effect.gen(function* () {
      const fake = makeFakeOmpSpawner("/tmp/omp-textgen.jsonl");
      const textGeneration = yield* makeTextGeneration(fake);

      const result = yield* textGeneration.generateThreadTitle({
        cwd: "/proj",
        message: "Please wire omp text generation so thread titles work again",
        modelSelection: BARE_LUNA_MODEL,
      });

      NodeAssert.equal(result.title, "Wire Omp Thread Titles");
      NodeAssert.deepEqual(fake.setModels[0], {
        provider: "openai-codex",
        modelId: "gpt-5.6-luna",
      });
    }),
  );

  it.effect("generateThreadTitle falls back to thinking_delta JSON when text_delta is absent", () =>
    Effect.gen(function* () {
      const fake = makeFakeOmpSpawner("/tmp/omp-textgen.jsonl", "thinking_delta");
      const textGeneration = yield* makeTextGeneration(fake);

      const result = yield* textGeneration.generateThreadTitle({
        cwd: "/proj",
        message: "Please wire omp text generation so thread titles work again",
        modelSelection: TITLE_MODEL,
      });

      NodeAssert.equal(result.title, "Wire Omp Thread Titles");
    }),
  );

  it.effect("generateThreadTitle reads thinking blocks on the completed assistant message", () =>
    Effect.gen(function* () {
      const fake = makeFakeOmpSpawner("/tmp/omp-textgen.jsonl", "thinking_content");
      const textGeneration = yield* makeTextGeneration(fake);

      const result = yield* textGeneration.generateThreadTitle({
        cwd: "/proj",
        message: "Please wire omp text generation so thread titles work again",
        modelSelection: TITLE_MODEL,
      });

      NodeAssert.equal(result.title, "Wire Omp Thread Titles");
    }),
  );

  it.effect("generateThreadTitle reads completed assistant message content without deltas", () =>
    Effect.gen(function* () {
      const fake = makeFakeOmpSpawner("/tmp/omp-textgen.jsonl", "message_end");
      const textGeneration = yield* makeTextGeneration(fake);

      const result = yield* textGeneration.generateThreadTitle({
        cwd: "/proj",
        message: "Please wire omp text generation so thread titles work again",
        modelSelection: TITLE_MODEL,
      });

      NodeAssert.equal(result.title, "Wire Omp Thread Titles");
    }),
  );

  it.effect("generateThreadTitle uses get_last_assistant_text when the stream has no content", () =>
    Effect.gen(function* () {
      const fake = makeFakeOmpSpawner("/tmp/omp-textgen.jsonl", "last_assistant_text");
      const textGeneration = yield* makeTextGeneration(fake);

      const result = yield* textGeneration.generateThreadTitle({
        cwd: "/proj",
        message: "Please wire omp text generation so thread titles work again",
        modelSelection: TITLE_MODEL,
      });

      NodeAssert.equal(result.title, "Wire Omp Thread Titles");
    }),
  );

  it.effect("generateThreadTitle auto-confirms workspace UI so the helper can emit text", () =>
    Effect.gen(function* () {
      const fake = makeFakeOmpSpawner("/tmp/omp-textgen.jsonl", "confirm_then_text");
      const textGeneration = yield* makeTextGeneration(fake);

      const result = yield* textGeneration.generateThreadTitle({
        cwd: "/proj",
        message: "Please wire omp text generation so thread titles work again",
        modelSelection: TITLE_MODEL,
      });

      NodeAssert.equal(result.title, "Wire Omp Thread Titles");
      NodeAssert.equal(fake.uiResponses.length, 1);
      NodeAssert.deepEqual(fake.uiResponses[0], {
        type: "extension_ui_response",
        id: "ui-confirm-1",
        confirmed: true,
      });
    }),
  );

  it.effect("generateThreadTitle answers select UI with the first option then collects text", () =>
    Effect.gen(function* () {
      const fake = makeFakeOmpSpawner("/tmp/omp-textgen.jsonl", "select_then_text");
      const textGeneration = yield* makeTextGeneration(fake);

      const result = yield* textGeneration.generateThreadTitle({
        cwd: "/proj",
        message: "Please wire omp text generation so thread titles work again",
        modelSelection: TITLE_MODEL,
      });

      NodeAssert.equal(result.title, "Wire Omp Thread Titles");
      NodeAssert.deepEqual(fake.uiResponses[0], {
        type: "extension_ui_response",
        id: "ui-select-1",
        value: "openai-codex",
      });
    }),
  );

  it.effect(
    "generateThreadTitle surfaces an assistant provider error instead of empty output",
    () =>
      Effect.gen(function* () {
        const fake = makeFakeOmpSpawner("/tmp/omp-textgen.jsonl", "provider_error");
        const textGeneration = yield* makeTextGeneration(fake);

        const error = yield* textGeneration
          .generateThreadTitle({
            cwd: "/proj",
            message: "Please wire omp text generation so thread titles work again",
            modelSelection: TITLE_MODEL,
          })
          .pipe(Effect.flip);

        NodeAssert.equal(isTextGenerationError(error), true);
        NodeAssert.match(error.detail, /401/);
        NodeAssert.doesNotMatch(error.detail, /empty output/);
      }),
  );

  it.effect("generateThreadTitle still fails when omp emits no assistant text", () =>
    Effect.gen(function* () {
      const fake = makeFakeOmpSpawner("/tmp/omp-textgen.jsonl", "empty");
      const textGeneration = yield* makeTextGeneration(fake);

      const error = yield* textGeneration
        .generateThreadTitle({
          cwd: "/proj",
          message: "Please wire omp text generation so thread titles work again",
          modelSelection: TITLE_MODEL,
        })
        .pipe(Effect.flip);

      NodeAssert.equal(isTextGenerationError(error), true);
      NodeAssert.match(error.detail, /empty output/);
    }),
  );
});
