/**
 * OmpRpcRuntime — process owner for `omp --mode rpc` over stdio NDJSON.
 *
 * Owns spawn/kill, protocol v2 negotiate, strict rpc_chunk reassembly,
 * request correlation, and resume via switch_session. Adapter code maps
 * logical frames; this module never invents ProviderRuntimeEvent values.
 *
 * @module provider/omp/OmpRpcRuntime
 */
import { mergePathValues } from "@t3tools/shared/shell";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

/** Maximum UTF-8 size of one newline-delimited RPC frame, including the newline. */
export const MAX_RPC_FRAME_BYTES = 1024 * 1024;
/** Maximum UTF-8 size of one logical frame reassembled by protocol v2. */
export const MAX_RPC_REASSEMBLED_BYTES = 64 * 1024 * 1024;
export const RPC_CHUNK_PAYLOAD_BYTES = 256 * 1024;

const UnknownJson = Schema.fromJsonString(Schema.Unknown);
const decodeUnknownJson = Schema.decodeSync(UnknownJson);
const encodeUnknownJson = Schema.encodeSync(UnknownJson);

interface PendingRpcChunks {
  chunkId: string;
  count: number;
  byteLength: number;
  nextIndex: number;
  chunks: Buffer[];
  receivedBytes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRpcChunkFrame(value: unknown): value is {
  readonly type: "rpc_chunk";
  readonly chunkId: unknown;
  readonly index: unknown;
  readonly count: unknown;
  readonly byteLength: unknown;
  readonly data: unknown;
} {
  return isRecord(value) && value.type === "rpc_chunk";
}

function decodeBase64(data: unknown): Buffer {
  if (
    typeof data !== "string" ||
    data.length === 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
  ) {
    throw new Error("invalid rpc chunk data");
  }
  const bytes = Buffer.from(data, "base64");
  if (bytes.toString("base64") !== data) {
    throw new Error("invalid rpc chunk data");
  }
  return bytes;
}

/**
 * Reassemble protocol v2 chunk frames after each JSONL line has been parsed.
 * Mirrors omp `RpcFrameDecoder` validation rules (AC12).
 */
export class OmpRpcFrameDecoder {
  #pending: PendingRpcChunks | undefined;

  push(value: unknown): object | undefined {
    if (!isRpcChunkFrame(value)) {
      if (this.#pending) {
        throw new Error("rpc chunk sequence interrupted");
      }
      if (!isRecord(value)) {
        throw new Error("rpc frame must be an object");
      }
      return value;
    }

    const { chunkId, index, count, byteLength } = value;
    if (
      typeof chunkId !== "string" ||
      chunkId.length === 0 ||
      chunkId.length > 128 ||
      typeof index !== "number" ||
      typeof count !== "number" ||
      typeof byteLength !== "number" ||
      !Number.isSafeInteger(index) ||
      !Number.isSafeInteger(count) ||
      !Number.isSafeInteger(byteLength) ||
      index < 0 ||
      count < 2 ||
      count > Math.ceil(MAX_RPC_REASSEMBLED_BYTES / RPC_CHUNK_PAYLOAD_BYTES) ||
      index >= count ||
      byteLength < MAX_RPC_FRAME_BYTES ||
      byteLength > MAX_RPC_REASSEMBLED_BYTES
    ) {
      throw new Error("invalid rpc chunk metadata");
    }

    const bytes = decodeBase64(value.data);
    if (bytes.byteLength > RPC_CHUNK_PAYLOAD_BYTES) {
      throw new Error("rpc chunk payload exceeds the transport limit");
    }

    let pending = this.#pending;
    if (!pending) {
      if (index !== 0) {
        throw new Error("rpc chunk sequence must start at index 0");
      }
      pending = {
        chunkId,
        count,
        byteLength,
        nextIndex: 0,
        chunks: [],
        receivedBytes: 0,
      };
      this.#pending = pending;
    }

    if (
      pending.chunkId !== chunkId ||
      pending.count !== count ||
      pending.byteLength !== byteLength ||
      pending.nextIndex !== index
    ) {
      throw new Error("rpc chunk sequence mismatch");
    }

    pending.chunks.push(bytes);
    pending.receivedBytes += bytes.byteLength;
    pending.nextIndex += 1;

    if (pending.receivedBytes > pending.byteLength) {
      throw new Error("rpc chunk sequence exceeds declared length");
    }
    if (pending.nextIndex < pending.count) {
      return undefined;
    }
    if (pending.receivedBytes !== pending.byteLength) {
      throw new Error("rpc chunk sequence length mismatch");
    }

    this.#pending = undefined;
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(pending.chunks));
    const frame: unknown = decodeUnknownJson(decoded);
    if (!isRecord(frame)) {
      throw new Error("rpc frame must be an object");
    }
    return frame;
  }
}

export interface OmpEnsureSessionInput {
  readonly sessionKey: string;
  readonly cwd: string;
  readonly resumeCursor: string | null;
}

export interface OmpSessionHandle {
  readonly sessionKey: string;
  readonly sessionFile: string;
}

export class OmpSpawnError extends Schema.TaggedErrorClass<OmpSpawnError>()("OmpSpawnError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `omp rpc ${this.operation}: ${this.detail}`;
  }
}

interface LiveOmpSession {
  readonly handle: OmpSessionHandle;
  readonly child: ChildProcessSpawner.ChildProcessHandle;
  readonly scope: Scope.Scope;
  readonly frames: Queue.Queue<object>;
  readonly pending: Map<string, Deferred.Deferred<object, OmpSpawnError>>;
}

export interface OmpRpcRuntimeOptions {
  /** Directories prepended to PATH for the omp child (e.g. managed rtk). */
  readonly pathPrefixDirs?: ReadonlyArray<string>;
}

/**
 * Spawns and owns one `omp --mode rpc` child per T3 thread session.
 */
export class OmpRpcRuntime {
  readonly #sessions = new Map<string, LiveOmpSession>();
  #nextRequestId = 0;
  readonly #processSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  #binaryPath: string;
  readonly #pathPrefixDirs: ReadonlyArray<string>;

  public constructor(
    processSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
    binaryPath: string,
    options?: OmpRpcRuntimeOptions,
  ) {
    this.#processSpawner = processSpawner;
    this.#binaryPath = binaryPath;
    this.#pathPrefixDirs = options?.pathPrefixDirs ?? [];
  }

  /** Update the spawn binary after a managed install/refresh. */
  public setBinaryPath(binaryPath: string): void {
    this.#binaryPath = binaryPath;
  }

  public ensureSession(
    input: OmpEnsureSessionInput,
  ): Effect.Effect<OmpSessionHandle, OmpSpawnError> {
    return Effect.gen({ self: this }, function* () {
      const existing = this.#sessions.get(input.sessionKey);
      if (existing) {
        return existing.handle;
      }

      const platform = yield* HostProcessPlatform;
      const preferredPath =
        this.#pathPrefixDirs.length > 0
          ? this.#pathPrefixDirs.join(platform === "win32" ? ";" : ":")
          : undefined;
      const mergedPath = mergePathValues(preferredPath, process.env.PATH, platform);
      const scope = yield* Scope.make();
      const child = yield* this.#processSpawner
        .spawn(
          ChildProcess.make(this.#binaryPath, ["--mode", "rpc"], {
            cwd: input.cwd,
            extendEnv: true,
            ...(mergedPath !== undefined ? { env: { PATH: mergedPath } } : {}),
            // Keep stdin open across many RPC writes. Default endOnDone ends the
            // pipe after the first Stream.run, which hangs the next command.
            stdin: { stream: "pipe", endOnDone: false },
          }),
        )
        .pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.mapError(
            (cause) =>
              new OmpSpawnError({
                operation: "spawn",
                detail: "failed to spawn omp --mode rpc",
                cause,
              }),
          ),
        );

      const frames = yield* Queue.unbounded<object>();
      const pending = new Map<string, Deferred.Deferred<object, OmpSpawnError>>();
      const decoder = new OmpRpcFrameDecoder();

      yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach((line) => {
          const trimmed = line.trim();
          if (trimmed.length === 0) {
            return Effect.void;
          }
          return Effect.try({
            try: () => decoder.push(decodeUnknownJson(trimmed)),
            catch: (cause) =>
              new OmpSpawnError({
                operation: "decode",
                detail: "failed to decode omp stdout frame",
                cause,
              }),
          }).pipe(
            Effect.flatMap((frame) => {
              if (frame === undefined) {
                return Effect.void;
              }
              if (isRecord(frame) && frame.type === "response" && typeof frame.id === "string") {
                const waiter = pending.get(frame.id);
                if (waiter) {
                  pending.delete(frame.id);
                  return Deferred.succeed(waiter, frame).pipe(Effect.asVoid);
                }
              }
              return Queue.offer(frames, frame).pipe(Effect.asVoid);
            }),
          );
        }),
        Effect.forkIn(scope),
      );

      const handshake = Effect.gen({ self: this }, function* () {
        yield* waitForReady(frames);
        yield* this.#request(child, pending, {
          type: "negotiate_protocol",
          protocolVersion: 2,
        });
        if (input.resumeCursor !== null) {
          yield* this.#request(child, pending, {
            type: "switch_session",
            sessionPath: input.resumeCursor,
          });
        }
        const state = yield* this.#request(child, pending, { type: "get_state" });
        return yield* sessionFileFromState(state);
      });

      const sessionFile = yield* handshake.pipe(
        Effect.tapError(() =>
          child
            .kill()
            .pipe(Effect.ignore, Effect.andThen(Scope.close(scope, Exit.void)), Effect.ignore),
        ),
      );

      const handle: OmpSessionHandle = {
        sessionKey: input.sessionKey,
        sessionFile,
      };
      this.#sessions.set(input.sessionKey, { handle, child, scope, frames, pending });
      return handle;
    });
  }

  public send(
    sessionKey: string,
    command: Record<string, unknown>,
  ): Effect.Effect<object, OmpSpawnError> {
    return Effect.gen({ self: this }, function* () {
      const live = this.#sessions.get(sessionKey);
      if (!live) {
        return yield* new OmpSpawnError({
          operation: "send",
          detail: `no live omp session for ${sessionKey}`,
        });
      }
      return yield* this.#request(live.child, live.pending, command);
    });
  }

  /** Write a frame without waiting for a correlated `response` (e.g. extension_ui_response). */
  public write(
    sessionKey: string,
    command: Record<string, unknown>,
  ): Effect.Effect<void, OmpSpawnError> {
    return Effect.gen({ self: this }, function* () {
      const live = this.#sessions.get(sessionKey);
      if (!live) {
        return yield* new OmpSpawnError({
          operation: "write",
          detail: `no live omp session for ${sessionKey}`,
        });
      }
      const payload = `${encodeUnknownJson(command)}\n`;
      yield* Stream.run(Stream.encodeText(Stream.make(payload)), live.child.stdin).pipe(
        Effect.mapError(
          (cause) =>
            new OmpSpawnError({
              operation: String(command.type ?? "write"),
              detail: "failed to write omp rpc frame",
              cause,
            }),
        ),
      );
    });
  }

  public streamFrames(sessionKey: string): Stream.Stream<object, OmpSpawnError> {
    const live = this.#sessions.get(sessionKey);
    if (!live) {
      return Stream.fail(
        new OmpSpawnError({
          operation: "streamFrames",
          detail: `no live omp session for ${sessionKey}`,
        }),
      );
    }
    return Stream.fromQueue(live.frames);
  }

  public dispose(sessionKey: string): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const live = this.#sessions.get(sessionKey);
      if (!live) {
        return;
      }
      this.#sessions.delete(sessionKey);
      yield* live.child.kill().pipe(Effect.ignore);
      yield* Scope.close(live.scope, Exit.void).pipe(Effect.ignore);
    });
  }

  #request(
    child: ChildProcessSpawner.ChildProcessHandle,
    pending: Map<string, Deferred.Deferred<object, OmpSpawnError>>,
    command: Record<string, unknown>,
  ): Effect.Effect<object, OmpSpawnError> {
    return Effect.gen({ self: this }, function* () {
      const id = `omp-${String(++this.#nextRequestId)}`;
      const waiter = yield* Deferred.make<object, OmpSpawnError>();
      pending.set(id, waiter);
      const payload = `${encodeUnknownJson({ id, ...command })}\n`;
      yield* Stream.run(Stream.encodeText(Stream.make(payload)), child.stdin).pipe(
        Effect.mapError(
          (cause) =>
            new OmpSpawnError({
              operation: String(command.type),
              detail: "failed to write omp rpc command",
              cause,
            }),
        ),
      );
      const response = yield* Deferred.await(waiter);
      if (!isRecord(response) || response.success !== true) {
        return yield* new OmpSpawnError({
          operation: String(command.type),
          detail:
            isRecord(response) && typeof response.error === "string"
              ? response.error
              : "command failed",
        });
      }
      return response;
    });
  }
}

const waitForReady = (frames: Queue.Queue<object>): Effect.Effect<object, OmpSpawnError> =>
  Effect.gen(function* () {
    for (;;) {
      const frame = yield* Queue.take(frames);
      if (isRecord(frame) && frame.type === "ready") {
        return frame;
      }
    }
  });

function sessionFileFromState(response: object): Effect.Effect<string, OmpSpawnError> {
  if (
    !isRecord(response) ||
    !isRecord(response.data) ||
    typeof response.data.sessionFile !== "string" ||
    response.data.sessionFile.length === 0
  ) {
    return new OmpSpawnError({
      operation: "get_state",
      detail: "response missing sessionFile",
    });
  }
  return Effect.succeed(response.data.sessionFile);
}
