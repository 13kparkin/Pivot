/**
 * OmpRpcRuntime — process owner for `omp --mode rpc` over stdio NDJSON.
 *
 * Owns spawn/kill, protocol v2 negotiate, strict rpc_chunk reassembly,
 * request correlation, and resume via switch_session. Adapter code maps
 * logical frames; this module never invents ProviderRuntimeEvent values.
 *
 * @module provider/omp/OmpRpcRuntime
 */

/** Maximum UTF-8 size of one newline-delimited RPC frame, including the newline. */
export const MAX_RPC_FRAME_BYTES = 1024 * 1024;
/** Maximum UTF-8 size of one logical frame reassembled by protocol v2. */
export const MAX_RPC_REASSEMBLED_BYTES = 64 * 1024 * 1024;
export const RPC_CHUNK_PAYLOAD_BYTES = 256 * 1024;

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

    if (!this.#pending) {
      if (index !== 0) {
        throw new Error("rpc chunk sequence must start at index 0");
      }
      this.#pending = {
        chunkId,
        count,
        byteLength,
        nextIndex: 0,
        chunks: [],
        receivedBytes: 0,
      };
    }

    const pending = this.#pending;
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
    const frame: unknown = JSON.parse(decoded);
    if (!isRecord(frame)) {
      throw new Error("rpc frame must be an object");
    }
    return frame;
  }
}
