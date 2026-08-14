import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { OmpSettings, ProviderInstanceId } from "@t3tools/contracts";
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
const UnknownJson = Schema.fromJsonString(Schema.Unknown);
const decodeUnknownJson = Schema.decodeSync(UnknownJson);
const encodeUnknownJson = Schema.encodeSync(UnknownJson);

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

function makeFakeOmpSpawner(sessionFile: string) {
  const prompts: string[] = [];
  const setModels: Array<{ provider: string; modelId: string }> = [];
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
      asSpawnedCommand(command);
      const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode, never>();
      let stdinBuf = "";
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
                } else if (rpcCommand.type === "prompt") {
                  prompts.push(typeof rpcCommand.message === "string" ? rpcCommand.message : "");
                  yield* offer({
                    id: rpcCommand.id,
                    type: "response",
                    command: "prompt",
                    success: true,
                    data: { agentInvoked: true },
                  });
                  yield* offer({
                    type: "message_update",
                    assistantMessageEvent: {
                      type: "text_delta",
                      delta: '{"title":"Wire Omp Thread Titles"}',
                    },
                  });
                  yield* offer({
                    type: "agent_end",
                    isTerminal: true,
                  });
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
  return { spawner, prompts, setModels };
}

describe("OmpTextGeneration", () => {
  it.effect("generateThreadTitle collects text_delta JSON and sanitizes the title", () =>
    Effect.gen(function* () {
      const fake = makeFakeOmpSpawner("/tmp/omp-textgen.jsonl");
      const textGeneration = yield* makeOmpTextGeneration(
        decodeOmpSettings({
          enabled: true,
          binaryPath: "/opt/omp",
        }),
      ).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
        Effect.provide(NodeServices.layer),
      );

      const result = yield* textGeneration.generateThreadTitle({
        cwd: "/proj",
        message: "Please wire omp text generation so thread titles work again",
        modelSelection: createModelSelection(ProviderInstanceId.make("omp"), "openai/gpt-5"),
      });

      NodeAssert.equal(result.title, "Wire Omp Thread Titles");
      NodeAssert.equal(fake.setModels.length, 1);
      NodeAssert.deepEqual(fake.setModels[0], { provider: "openai", modelId: "gpt-5" });
      NodeAssert.ok(fake.prompts[0]?.includes("Generate a title"));
    }),
  );
});
