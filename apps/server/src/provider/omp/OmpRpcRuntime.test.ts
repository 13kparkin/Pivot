// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";

import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { describe } from "vite-plus/test";

const realOmpBinary = (() => {
  try {
    return NodeChildProcess.execFileSync("which", ["omp"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
})();

import {
  MAX_RPC_FRAME_BYTES,
  MAX_RPC_REASSEMBLED_BYTES,
  OmpRpcFrameDecoder,
  OmpRpcRuntime,
  OmpSpawnError,
  RPC_CHUNK_PAYLOAD_BYTES,
} from "./OmpRpcRuntime.ts";

const isOmpSpawnError = Schema.is(OmpSpawnError);

const UnknownJson = Schema.fromJsonString(Schema.Unknown);
const decodeUnknownJson = Schema.decodeSync(UnknownJson);
const encodeUnknownJson = Schema.encodeSync(UnknownJson);

function makeChunkFrame(input: {
  readonly chunkId: string;
  readonly index: number;
  readonly count: number;
  readonly byteLength: number;
  readonly data: Buffer;
}) {
  return {
    type: "rpc_chunk",
    chunkId: input.chunkId,
    index: input.index,
    count: input.count,
    byteLength: input.byteLength,
    data: input.data.toString("base64"),
  };
}

function splitIntoChunkFrames(logical: object, chunkId = "rpc-1") {
  const bytes = Buffer.from(JSON.stringify(logical), "utf8");
  NodeAssert.ok(bytes.byteLength >= MAX_RPC_FRAME_BYTES);
  const count = Math.ceil(bytes.byteLength / RPC_CHUNK_PAYLOAD_BYTES);
  NodeAssert.ok(count >= 2);
  return Array.from({ length: count }, (_, index) =>
    makeChunkFrame({
      chunkId,
      index,
      count,
      byteLength: bytes.byteLength,
      data: bytes.subarray(index * RPC_CHUNK_PAYLOAD_BYTES, (index + 1) * RPC_CHUNK_PAYLOAD_BYTES),
    }),
  );
}

describe("OmpRpcFrameDecoder", () => {
  it("passes through non-chunk frames", () => {
    const decoder = new OmpRpcFrameDecoder();
    const frame = { type: "ready", protocolVersion: 1 };
    NodeAssert.deepEqual(decoder.push(frame), frame);
  });

  it("reassembles a fragmented rpc_chunk sequence into one logical frame", () => {
    const decoder = new OmpRpcFrameDecoder();
    const logical = {
      type: "response",
      command: "get_messages",
      success: true,
      data: { messages: ["x".repeat(MAX_RPC_FRAME_BYTES)] },
    };
    const chunks = splitIntoChunkFrames(logical);

    for (const chunk of chunks.slice(0, -1)) {
      NodeAssert.equal(decoder.push(chunk), undefined);
    }
    NodeAssert.deepEqual(decoder.push(chunks[chunks.length - 1]!), logical);
  });

  it("fails when a chunk sequence is interrupted by a non-chunk frame", () => {
    const decoder = new OmpRpcFrameDecoder();
    const chunks = splitIntoChunkFrames({
      type: "response",
      command: "get_messages",
      success: true,
      data: { pad: "y".repeat(MAX_RPC_FRAME_BYTES) },
    });
    NodeAssert.equal(decoder.push(chunks[0]!), undefined);
    NodeAssert.throws(() => decoder.push({ type: "ready" }), /interrupted/i);
  });

  it("fails when declared reassembled size exceeds the ceiling", () => {
    const decoder = new OmpRpcFrameDecoder();
    NodeAssert.throws(
      () =>
        decoder.push(
          makeChunkFrame({
            chunkId: "rpc-1",
            index: 0,
            count: 2,
            byteLength: MAX_RPC_REASSEMBLED_BYTES + 1,
            data: Buffer.alloc(16, 1),
          }),
        ),
      /invalid rpc chunk metadata|reassembl/i,
    );
  });

  it("fails when chunk indexes are out of order", () => {
    const decoder = new OmpRpcFrameDecoder();
    const chunks = splitIntoChunkFrames({
      type: "response",
      command: "get_messages",
      success: true,
      data: { pad: "z".repeat(MAX_RPC_FRAME_BYTES) },
    });
    NodeAssert.throws(() => decoder.push(chunks[1]!), /index 0|sequence must start/i);
  });
});

type SpawnedCommand = {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: {
    readonly cwd?: string;
    readonly extendEnv?: boolean;
    readonly env?: Record<string, string>;
    readonly stdin?: { readonly stream: "pipe"; readonly endOnDone: false };
  };
};

type FakeOmpSpawn = SpawnedCommand & {
  readonly commands: Array<Record<string, unknown>>;
  killed: boolean;
  /** Resolves when the fake child exits; the runtime watcher reacts to it. */
  readonly exit: Deferred.Deferred<ChildProcessSpawner.ExitCode, never>;
};

function asSpawnedCommand(command: ChildProcess.Command): SpawnedCommand {
  if (command._tag !== "StandardCommand") {
    throw new Error("expected StandardCommand");
  }
  const stdin = command.options.stdin;
  const env = command.options.env;
  return {
    command: command.command,
    args: command.args,
    options: {
      ...(typeof command.options.cwd === "string" ? { cwd: command.options.cwd } : {}),
      ...(typeof command.options.extendEnv === "boolean"
        ? { extendEnv: command.options.extendEnv }
        : {}),
      ...(env && typeof env === "object" ? { env: env as Record<string, string> } : {}),
      ...(typeof stdin === "object" &&
      stdin !== null &&
      "stream" in stdin &&
      stdin.stream === "pipe" &&
      stdin.endOnDone === false
        ? { stdin: { stream: "pipe" as const, endOnDone: false as const } }
        : {}),
    },
  };
}

function hasModeRpc(args: ReadonlyArray<string>): boolean {
  const modeIndex = args.indexOf("--mode");
  return (modeIndex >= 0 && args[modeIndex + 1] === "rpc") || args.includes("--mode=rpc");
}

function makeFakeOmpSpawner(input: { readonly sessionFile: string }) {
  const spawns: FakeOmpSpawn[] = [];
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
        maxFrameBytes: MAX_RPC_FRAME_BYTES,
        maxReassembledFrameBytes: MAX_RPC_REASSEMBLED_BYTES,
      });
      const spawned = asSpawnedCommand(command);
      const spawn: FakeOmpSpawn = {
        ...spawned,
        commands: [],
        killed: false,
        exit: yield* Deferred.make<ChildProcessSpawner.ExitCode, never>(),
      };
      spawns.push(spawn);
      let sessionFile = input.sessionFile;
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
                spawn.commands.push(rpcCommand);
                if (rpcCommand.type === "negotiate_protocol") {
                  yield* offer({
                    id: rpcCommand.id,
                    type: "response",
                    command: "negotiate_protocol",
                    success: true,
                    data: { protocolVersion: 2 },
                  });
                } else if (rpcCommand.type === "switch_session") {
                  sessionFile = String(rpcCommand.sessionPath);
                  yield* offer({
                    id: rpcCommand.id,
                    type: "response",
                    command: "switch_session",
                    success: true,
                  });
                } else if (rpcCommand.type === "get_state") {
                  yield* offer({
                    id: rpcCommand.id,
                    type: "response",
                    command: "get_state",
                    success: true,
                    data: { sessionFile },
                  });
                } else if (rpcCommand.type === "prompt") {
                  yield* offer({ type: "agent_start" });
                  yield* offer({
                    id: rpcCommand.id,
                    type: "response",
                    command: "prompt",
                    success: true,
                    data: { agentInvoked: true },
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
  const exitSpawn = (spawn: FakeOmpSpawn, code = 0) =>
    Effect.sync(() => {
      spawn.killed = true;
    }).pipe(
      Effect.andThen(
        Deferred.succeed(spawn.exit, ChildProcessSpawner.ExitCode(code)).pipe(Effect.asVoid),
      ),
    );
  return { spawner, spawns, exitSpawn };
}

describe("OmpRpcRuntime", () => {
  it.effect("spawns the configured binary in rpc mode without disabling extensions", () =>
    Effect.gen(function* () {
      const fake = makeFakeOmpSpawner({ sessionFile: "/tmp/omp-session.jsonl" });
      const runtime = new OmpRpcRuntime(fake.spawner, "/opt/omp", {
        pathPrefixDirs: ["/managed/rtk/current"],
      });
      yield* runtime.ensureSession({
        sessionKey: "thread-1",
        cwd: "/proj",
        resumeCursor: null,
      });
      NodeAssert.equal(fake.spawns.length, 1);
      NodeAssert.equal(fake.spawns[0]?.command, "/opt/omp");
      NodeAssert.ok(hasModeRpc(fake.spawns[0]?.args ?? []));
      NodeAssert.ok(!(fake.spawns[0]?.args ?? []).includes("--no-extensions"));
      NodeAssert.equal(fake.spawns[0]?.options.cwd, "/proj");
      NodeAssert.equal(fake.spawns[0]?.options.extendEnv, true);
      NodeAssert.deepEqual(fake.spawns[0]?.options.stdin, { stream: "pipe", endOnDone: false });
      const pathEnv = fake.spawns[0]?.options.env?.PATH ?? "";
      NodeAssert.ok(pathEnv.includes("/managed/rtk/current"));
    }),
  );

  it.effect("waits for ready, negotiates protocol v2, and returns sessionFile from get_state", () =>
    Effect.gen(function* () {
      const fake = makeFakeOmpSpawner({ sessionFile: "/tmp/omp-session.jsonl" });
      const runtime = new OmpRpcRuntime(fake.spawner, "/opt/omp");
      const handle = yield* runtime.ensureSession({
        sessionKey: "thread-1",
        cwd: "/proj",
        resumeCursor: null,
      });
      NodeAssert.deepEqual(
        fake.spawns[0]?.commands.map((command) => command.type),
        ["negotiate_protocol", "get_state"],
      );
      NodeAssert.equal(fake.spawns[0]?.commands[0]?.protocolVersion, 2);
      NodeAssert.equal(handle.sessionKey, "thread-1");
      NodeAssert.equal(handle.sessionFile, "/tmp/omp-session.jsonl");
    }),
  );

  it.effect("resumes an existing omp session via switch_session", () =>
    Effect.gen(function* () {
      const fake = makeFakeOmpSpawner({ sessionFile: "/tmp/new.jsonl" });
      const runtime = new OmpRpcRuntime(fake.spawner, "/opt/omp");
      const handle = yield* runtime.ensureSession({
        sessionKey: "thread-1",
        cwd: "/proj",
        resumeCursor: "/tmp/existing.jsonl",
      });
      NodeAssert.deepEqual(
        fake.spawns[0]?.commands.map((command) => command.type),
        ["negotiate_protocol", "switch_session", "get_state"],
      );
      NodeAssert.equal(fake.spawns[0]?.commands[1]?.sessionPath, "/tmp/existing.jsonl");
      NodeAssert.equal(handle.sessionFile, "/tmp/existing.jsonl");
    }),
  );

  it.effect("spawns an independent child per session key", () =>
    Effect.gen(function* () {
      const fake = makeFakeOmpSpawner({ sessionFile: "/tmp/omp-session.jsonl" });
      const runtime = new OmpRpcRuntime(fake.spawner, "/opt/omp");
      yield* runtime.ensureSession({
        sessionKey: "thread-a",
        cwd: "/proj-a",
        resumeCursor: null,
      });
      yield* runtime.ensureSession({
        sessionKey: "thread-b",
        cwd: "/proj-b",
        resumeCursor: null,
      });
      NodeAssert.equal(fake.spawns.length, 2);
      NodeAssert.equal(fake.spawns[0]?.options.cwd, "/proj-a");
      NodeAssert.equal(fake.spawns[1]?.options.cwd, "/proj-b");
    }),
  );

  it.effect("fails in-flight requests and ends streamFrames when the child exits", () =>
    Effect.gen(function* () {
      const fake = makeFakeOmpSpawner({ sessionFile: "/tmp/omp-session.jsonl" });
      const runtime = new OmpRpcRuntime(fake.spawner, "/opt/omp");
      yield* runtime.ensureSession({
        sessionKey: "thread-1",
        cwd: "/proj",
        resumeCursor: null,
      });
      const framesFiber = yield* Stream.runCollect(runtime.streamFrames("thread-1")).pipe(
        Effect.forkScoped,
      );
      // get_available_models gets no correlated response from the fake, so the
      // request stays pending until the child exits.
      const sendFiber = yield* runtime
        .send("thread-1", { type: "get_available_models" })
        .pipe(Effect.forkScoped);
      // Wait until the fake child observed the command: by then the request's
      // pending Deferred is registered and its liveness check passed, so the
      // exit watcher — not the liveness fast-path — must fail it.
      let observed = false;
      for (let i = 0; i < 100 && !observed; i++) {
        yield* Effect.yieldNow;
        observed = (fake.spawns[0]?.commands ?? []).length >= 1;
      }
      NodeAssert.equal(observed, true);
      yield* fake.exitSpawn(fake.spawns[0]!, 137);
      const sendOutcome = yield* Fiber.join(sendFiber).pipe(Effect.exit);
      NodeAssert.equal(Exit.isFailure(sendOutcome), true);
      if (Exit.isFailure(sendOutcome)) {
        const error = Cause.squash(sendOutcome.cause);
        NodeAssert.ok(isOmpSpawnError(error));
        NodeAssert.match(error.message, /child exited \(code 137\)/);
      }
      // The frames stream ends when the child exits (the queue is shut down;
      // the pull may surface as success or interrupt — either way it must not
      // hang and must carry no buffered frames).
      const framesOutcome = yield* Fiber.join(framesFiber).pipe(Effect.exit);
      const frames = Exit.isSuccess(framesOutcome) ? framesOutcome.value : [];
      NodeAssert.equal(frames.length, 0);
    }).pipe(Effect.scoped),
  );

  it.effect("dispose kills the live child so the next ensureSession respawns", () =>
    Effect.gen(function* () {
      const fake = makeFakeOmpSpawner({ sessionFile: "/tmp/omp-session.jsonl" });
      const runtime = new OmpRpcRuntime(fake.spawner, "/opt/omp");
      yield* runtime.ensureSession({
        sessionKey: "thread-1",
        cwd: "/proj",
        resumeCursor: null,
      });
      yield* runtime.ensureSession({
        sessionKey: "thread-1",
        cwd: "/proj",
        resumeCursor: null,
      });
      NodeAssert.equal(fake.spawns.length, 1);
      yield* runtime.dispose("thread-1");
      NodeAssert.equal(fake.spawns[0]?.killed, true);
      yield* runtime.ensureSession({
        sessionKey: "thread-1",
        cwd: "/proj",
        resumeCursor: null,
      });
      NodeAssert.equal(fake.spawns.length, 2);
    }),
  );

  it.effect("send correlates a prompt response and streamFrames yields agent events", () =>
    Effect.gen(function* () {
      const fake = makeFakeOmpSpawner({ sessionFile: "/tmp/omp-session.jsonl" });
      const runtime = new OmpRpcRuntime(fake.spawner, "/opt/omp");
      yield* runtime.ensureSession({
        sessionKey: "thread-1",
        cwd: "/proj",
        resumeCursor: null,
      });
      const eventsFiber = yield* Stream.runCollect(
        Stream.take(runtime.streamFrames("thread-1"), 1),
      ).pipe(Effect.forkChild);
      const response = yield* runtime.send("thread-1", { type: "prompt", message: "hi" });
      const events = Array.from(yield* Fiber.join(eventsFiber));
      NodeAssert.equal(
        typeof response === "object" &&
          response !== null &&
          "success" in response &&
          response.success,
        true,
      );
      NodeAssert.equal(fake.spawns[0]?.commands.at(-1)?.type, "prompt");
      NodeAssert.equal(fake.spawns[0]?.commands.at(-1)?.message, "hi");
      NodeAssert.equal(
        events[0] && typeof events[0] === "object" && "type" in events[0]
          ? events[0].type
          : undefined,
        "agent_start",
      );
    }),
  );

  it.effect.skipIf(!realOmpBinary)("live omp ensureSession completes", () =>
    Effect.gen(function* () {
      const runtime = new OmpRpcRuntime(
        yield* ChildProcessSpawner.ChildProcessSpawner,
        realOmpBinary!,
      );
      const handle = yield* runtime
        .ensureSession({
          sessionKey: "live-ensure",
          cwd: "/tmp",
          resumeCursor: null,
        })
        .pipe(Effect.timeout("20 seconds"));
      NodeAssert.ok(handle.sessionFile.length > 0);
      yield* runtime.dispose("live-ensure");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.skipIf(!realOmpBinary)("live omp get_available_models without streamFrames drain", () =>
    Effect.gen(function* () {
      const runtime = new OmpRpcRuntime(
        yield* ChildProcessSpawner.ChildProcessSpawner,
        realOmpBinary!,
      );
      yield* runtime.ensureSession({
        sessionKey: "live-models-nodrain",
        cwd: "/tmp",
        resumeCursor: null,
      });
      const response = yield* runtime
        .send("live-models-nodrain", { type: "get_available_models" })
        .pipe(Effect.timeout("30 seconds"));
      const models =
        typeof response === "object" &&
        response !== null &&
        "data" in response &&
        typeof response.data === "object" &&
        response.data !== null &&
        "models" in response.data &&
        Array.isArray(response.data.models)
          ? response.data.models
          : [];
      NodeAssert.ok(models.length > 1, `expected many models, got ${String(models.length)}`);
      yield* runtime.dispose("live-models-nodrain");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.skipIf(!realOmpBinary)(
    "live omp get_available_models while draining streamFrames",
    () =>
      Effect.gen(function* () {
        const runtime = new OmpRpcRuntime(
          yield* ChildProcessSpawner.ChildProcessSpawner,
          realOmpBinary!,
        );
        yield* runtime.ensureSession({
          sessionKey: "live-models-drain",
          cwd: "/tmp",
          resumeCursor: null,
        });
        yield* runtime.streamFrames("live-models-drain").pipe(Stream.runDrain, Effect.forkChild);
        const response = yield* runtime
          .send("live-models-drain", { type: "get_available_models" })
          .pipe(Effect.timeout("30 seconds"));
        const models =
          typeof response === "object" &&
          response !== null &&
          "data" in response &&
          typeof response.data === "object" &&
          response.data !== null &&
          "models" in response.data &&
          Array.isArray(response.data.models)
            ? response.data.models
            : [];
        NodeAssert.ok(models.length > 1, `expected many models, got ${String(models.length)}`);
        yield* runtime.dispose("live-models-drain");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
