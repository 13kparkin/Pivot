import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { describe } from "vite-plus/test";

import { OmpDriver } from "./OmpDriver.ts";

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
  const spawns: Array<{
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly options: { readonly cwd?: string; readonly extendEnv?: boolean };
    killed: boolean;
  }> = [];
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const stdout = yield* Queue.unbounded<Uint8Array>();
      const offer = (frame: unknown) =>
        Queue.offer(stdout, encoder.encode(`${JSON.stringify(frame)}\n`));
      yield* offer({
        type: "ready",
        protocolVersion: 1,
        supportedProtocolVersions: [1, 2],
      });
      const spawned = asSpawnedCommand(command);
      const spawn = { ...spawned, killed: false };
      spawns.push(spawn);
      let stdinBuf = "";
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(spawns.length),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.sync(() => !spawn.killed),
        kill: () =>
          Effect.sync(() => {
            spawn.killed = true;
          }),
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((chunk: Uint8Array) => {
          stdinBuf += decoder.decode(chunk, { stream: true });
          return Effect.gen(function* () {
            let newlineIndex = stdinBuf.indexOf("\n");
            while (newlineIndex >= 0) {
              const line = stdinBuf.slice(0, newlineIndex).trim();
              stdinBuf = stdinBuf.slice(newlineIndex + 1);
              if (line.length > 0) {
                const rpcCommand = JSON.parse(line) as Record<string, unknown>;
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
                    data: {
                      models: [{ provider: "openai", id: "gpt-5", name: "GPT-5" }],
                    },
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
  return { spawner, spawns };
}

describe("OmpDriver", () => {
  it.effect("create wires adapter sessions through the configured omp binary", () =>
    Effect.gen(function* () {
      const fake = makeFakeOmpSpawner("/tmp/omp-session.jsonl");
      const instance = yield* OmpDriver.create({
        instanceId: ProviderInstanceId.make("omp"),
        displayName: "omp",
        accentColor: undefined,
        environment: {},
        enabled: true,
        config: { enabled: true, binaryPath: "/opt/omp" },
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner));

      NodeAssert.equal(instance.driverKind, ProviderDriverKind.make("omp"));
      NodeAssert.equal(instance.adapter.provider, ProviderDriverKind.make("omp"));

      const session = yield* instance.adapter.startSession({
        threadId: ThreadId.make("thread-1"),
        provider: ProviderDriverKind.make("omp"),
        cwd: "/proj",
        runtimeMode: "full-access",
      });

      NodeAssert.equal(fake.spawns.length, 1);
      NodeAssert.equal(fake.spawns[0]?.command, "/opt/omp");
      NodeAssert.ok(fake.spawns[0]?.args.includes("--mode"));
      NodeAssert.equal(session.resumeCursor, "/tmp/omp-session.jsonl");
    }).pipe(Effect.scoped),
  );

  it.effect("refresh populates models from get_available_models", () =>
    Effect.gen(function* () {
      const fake = makeFakeOmpSpawner("/tmp/omp-models.jsonl");
      const instance = yield* OmpDriver.create({
        instanceId: ProviderInstanceId.make("omp"),
        displayName: "omp",
        accentColor: undefined,
        environment: {},
        enabled: true,
        config: { enabled: true, binaryPath: "/opt/omp" },
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner));

      const snapshot = yield* instance.snapshot.refresh;
      NodeAssert.deepEqual(
        snapshot.models.map((model) => model.slug),
        ["openai/gpt-5"],
      );
      NodeAssert.equal(snapshot.models[0]?.name, "GPT-5");
    }).pipe(Effect.scoped),
  );
});
