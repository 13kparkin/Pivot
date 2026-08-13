import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  MAX_RPC_FRAME_BYTES,
  MAX_RPC_REASSEMBLED_BYTES,
  OmpRpcFrameDecoder,
} from "./OmpRpcRuntime.ts";

function chunkPayloadBytes(byteLength: number, chunkCount: number, index: number): Buffer {
  const size = Math.ceil(byteLength / chunkCount);
  const start = index * size;
  const end = Math.min(byteLength, start + size);
  return Buffer.alloc(end - start, index + 1);
}

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
    const json = JSON.stringify(logical);
    const bytes = Buffer.from(json, "utf8");
    NodeAssert.ok(bytes.byteLength > MAX_RPC_FRAME_BYTES);

    const chunkSize = Math.ceil(bytes.byteLength / 3);
    const chunks = [0, 1, 2].map((index) =>
      makeChunkFrame({
        chunkId: "rpc-1",
        index,
        count: 3,
        byteLength: bytes.byteLength,
        data: bytes.subarray(index * chunkSize, (index + 1) * chunkSize),
      }),
    );

    NodeAssert.equal(decoder.push(chunks[0]), undefined);
    NodeAssert.equal(decoder.push(chunks[1]), undefined);
    NodeAssert.deepEqual(decoder.push(chunks[2]), logical);
  });

  it("fails when a chunk sequence is interrupted by a non-chunk frame", () => {
    const decoder = new OmpRpcFrameDecoder();
    const first = makeChunkFrame({
      chunkId: "rpc-1",
      index: 0,
      count: 2,
      byteLength: MAX_RPC_FRAME_BYTES + 8,
      data: chunkPayloadBytes(MAX_RPC_FRAME_BYTES + 8, 2, 0),
    });
    NodeAssert.equal(decoder.push(first), undefined);
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
            data: Buffer.from("aa"),
          }),
        ),
      /invalid rpc chunk metadata|reassembl/i,
    );
  });

  it("fails when chunk indexes are out of order", () => {
    const decoder = new OmpRpcFrameDecoder();
    NodeAssert.throws(
      () =>
        decoder.push(
          makeChunkFrame({
            chunkId: "rpc-1",
            index: 1,
            count: 2,
            byteLength: MAX_RPC_FRAME_BYTES + 8,
            data: chunkPayloadBytes(MAX_RPC_FRAME_BYTES + 8, 2, 1),
          }),
        ),
      /index 0|sequence must start/i,
    );
  });
});
