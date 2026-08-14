// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { it } from "@effect/vitest";
import { OmpSettings, ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { describe } from "vite-plus/test";

import * as Option from "effect/Option";
import * as ProcessRunner from "../../processRunner.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OmpDriver } from "./OmpDriver.ts";

const decodeOmpSettings = Schema.decodeSync(OmpSettings);

function makeTempOmpBinary(): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-omp-driver-"));
  const binaryPath = NodePath.join(dir, "omp");
  NodeFS.writeFileSync(binaryPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return binaryPath;
}

const OmpDriverTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-omp-driver-test-",
}).pipe(
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(FetchHttpClient.layer),
  Layer.provideMerge(
    Layer.succeed(
      ProjectionSnapshotQuery,
      ProjectionSnapshotQuery.of({
        getCommandReadModel: () => Effect.succeed({ projects: [], threads: [], messages: [] }),
        getSnapshot: () => Effect.succeed({ projects: [], threads: [], messages: [] }),
        getShellSnapshot: () => Effect.succeed({ projects: [], threads: [] }),
        getArchivedShellSnapshot: () => Effect.succeed({ projects: [], threads: [] }),
        searchThreads: () => Effect.succeed({ threads: [], query: "" }),
        getSnapshotSequence: () => Effect.succeed(0),
        getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getProjectShellById: () => Effect.succeed(Option.none()),
        getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
        getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        getFullThreadDiffContext: () => Effect.succeed(Option.none()),
        getThreadShellById: () => Effect.succeed(Option.none()),
        getThreadDetailById: () => Effect.succeed(Option.none()),
        getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
      }),
    ),
  ),
);

const realOmpBinary = (() => {
  try {
    return NodeChildProcess.execFileSync("which", ["omp"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
})();

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

function makeFakeOmpSpawner(sessionFile: string, agentDir = "/tmp/t3-omp-agent") {
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
        Queue.offer(stdout, encoder.encode(`${encodeUnknownJson(frame)}\n`));
      const spawned = asSpawnedCommand(command);
      const spawn = {
        command: spawned.command,
        args: spawned.args,
        options: {
          ...(typeof spawned.options.cwd === "string" ? { cwd: spawned.options.cwd } : {}),
          ...(typeof spawned.options.extendEnv === "boolean"
            ? { extendEnv: spawned.options.extendEnv }
            : {}),
        },
        killed: false,
        exit: yield* Deferred.make<ChildProcessSpawner.ExitCode, never>(),
      };
      spawns.push(spawn);

      // `omp --version` probes and `omp config path` are plain CLI, not RPC.
      if (spawned.args.includes("--version")) {
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(spawns.length),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(encoder.encode("omp/17.3.0\n")),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }

      if (spawned.args[0] === "config" && spawned.args[1] === "path") {
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(spawns.length),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(encoder.encode(`${agentDir}\n`)),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }

      yield* offer({
        type: "ready",
        protocolVersion: 1,
        supportedProtocolVersions: [1, 2],
      });
      let stdinBuf = "";
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(spawns.length),
        exitCode: Deferred.await(spawn.exit),
        isRunning: Effect.sync(() => !spawn.killed),
        kill: () =>
          Effect.sync(() => {
            spawn.killed = true;
          }).pipe(
            Effect.andThen(
              Deferred.succeed(spawn.exit, ChildProcessSpawner.ExitCode(143)).pipe(Effect.ignore),
            ),
          ),
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
                    data: {
                      models: [{ provider: "openai", id: "gpt-5", name: "GPT-5" }],
                    },
                  });
                } else if (rpcCommand.type === "get_available_commands") {
                  yield* offer({
                    id: rpcCommand.id,
                    type: "response",
                    command: "get_available_commands",
                    success: true,
                    data: {
                      commands: [
                        { name: "model", description: "Switch model" },
                        { name: "review", description: "Review changes" },
                      ],
                    },
                  });
                } else if (Array.isArray(spawned.args) && spawned.args.includes("--version")) {
                  // Version probes are CLI argv, not RPC — handled below via stdout offer.
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
      const binaryPath = makeTempOmpBinary();
      const agentDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-omp-driver-agent-"));
      const fake = makeFakeOmpSpawner("/tmp/omp-session.jsonl", agentDir);
      const instance = yield* OmpDriver.create({
        instanceId: ProviderInstanceId.make("omp"),
        displayName: "omp",
        accentColor: undefined,
        environment: [],
        enabled: true,
        config: decodeOmpSettings({ enabled: true, binaryPath }),
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
        Effect.provide(
          ProcessRunner.layer.pipe(
            Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, fake.spawner)),
          ),
        ),
        Effect.provide(OmpDriverTestLayer),
      );

      NodeAssert.equal(instance.driverKind, ProviderDriverKind.make("omp"));
      NodeAssert.equal(instance.adapter.provider, ProviderDriverKind.make("omp"));

      // Drain the background model probe so spawn counts are stable.
      yield* instance.snapshot.refresh;
      const spawnsBeforeSession = fake.spawns.length;
      const session = yield* instance.adapter.startSession({
        threadId: ThreadId.make("thread-1"),
        provider: ProviderDriverKind.make("omp"),
        cwd: "/proj",
        runtimeMode: "full-access",
      });

      NodeAssert.equal(fake.spawns.length, spawnsBeforeSession + 1);
      const sessionSpawn = fake.spawns[fake.spawns.length - 1];
      NodeAssert.equal(sessionSpawn?.command, binaryPath);
      NodeAssert.ok(sessionSpawn?.args.includes("--mode"));
      NodeAssert.equal(session.resumeCursor, "/tmp/omp-session.jsonl");
    }).pipe(Effect.scoped),
  );

  it.effect("refresh populates models from get_available_models", () =>
    Effect.gen(function* () {
      const binaryPath = makeTempOmpBinary();
      const agentDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-omp-driver-agent-"));
      const fake = makeFakeOmpSpawner("/tmp/omp-models.jsonl", agentDir);
      const instance = yield* OmpDriver.create({
        instanceId: ProviderInstanceId.make("omp"),
        displayName: "omp",
        accentColor: undefined,
        environment: [],
        enabled: true,
        config: decodeOmpSettings({ enabled: true, binaryPath }),
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
        Effect.provide(
          ProcessRunner.layer.pipe(
            Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, fake.spawner)),
          ),
        ),
        Effect.provide(OmpDriverTestLayer),
      );

      const snapshot = yield* instance.snapshot.refresh;
      NodeAssert.deepEqual(
        snapshot.models.map((model) => model.slug),
        ["openai/gpt-5"],
      );
      NodeAssert.equal(snapshot.models[0]?.name, "GPT-5");
      NodeAssert.deepEqual(
        snapshot.slashCommands.map((command) => command.name),
        ["model", "review"],
      );
      NodeAssert.equal(snapshot.showInteractionModeToggle, true);
      NodeAssert.equal(snapshot.installed, true);
      NodeAssert.equal(snapshot.version, "17.3.0");
    }).pipe(Effect.scoped),
  );

  it.effect("refresh publishes models through streamChanges", () =>
    Effect.gen(function* () {
      const binaryPath = makeTempOmpBinary();
      const agentDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-omp-driver-agent-"));
      const fake = makeFakeOmpSpawner("/tmp/omp-models.jsonl", agentDir);
      const instance = yield* OmpDriver.create({
        instanceId: ProviderInstanceId.make("omp"),
        displayName: "omp",
        accentColor: undefined,
        environment: [],
        enabled: true,
        config: decodeOmpSettings({ enabled: true, binaryPath }),
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
        Effect.provide(
          ProcessRunner.layer.pipe(
            Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, fake.spawner)),
          ),
        ),
        Effect.provide(OmpDriverTestLayer),
      );

      // Drain the create-time background refresh before subscribing.
      yield* instance.snapshot.refresh;
      const updatesFiber = yield* instance.snapshot.streamChanges.pipe(
        Stream.filter((snapshot) => snapshot.models.length > 0),
        Stream.take(1),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* instance.snapshot.refresh;
      const updated = yield* Fiber.join(updatesFiber);
      NodeAssert.ok(updated._tag === "Some");
      NodeAssert.deepEqual(
        updated.value.models.map((model) => model.slug),
        ["openai/gpt-5"],
      );
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(!realOmpBinary)(
    "live omp refresh returns the full get_available_models catalog",
    () =>
      Effect.gen(function* () {
        const instance = yield* OmpDriver.create({
          instanceId: ProviderInstanceId.make("omp"),
          displayName: "omp",
          accentColor: undefined,
          environment: [],
          enabled: true,
          config: decodeOmpSettings({ enabled: true, binaryPath: realOmpBinary! }),
        }).pipe(
          Effect.provide(ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer))),
          Effect.provide(OmpDriverTestLayer),
        );

        const updated = yield* instance.snapshot.streamChanges.pipe(
          Stream.take(1),
          Stream.runHead,
          Effect.timeout("90 seconds"),
        );
        NodeAssert.ok(updated._tag === "Some");
        NodeAssert.ok(
          updated.value.models.length > 1,
          `expected many omp models, got ${String(updated.value.models.length)} (${updated.value.message})`,
        );
      }).pipe(Effect.scoped),
  );
});
