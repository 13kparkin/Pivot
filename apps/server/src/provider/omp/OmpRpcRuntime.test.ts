import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  MAX_RPC_FRAME_BYTES,
  MAX_RPC_REASSEMBLED_BYTES,
  OmpRpcFrameDecoder,
  RPC_CHUNK_PAYLOAD_BYTES,
} from "./OmpRpcRuntime.ts";

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
