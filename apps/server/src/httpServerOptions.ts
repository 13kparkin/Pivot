export const bunWebSocketOptions = {
  // Negotiate permessage-deflate with clients that offer it. A dedicated
  // compressor keeps a per-connection sliding window, while the shared
  // decompressor avoids uWebSockets' dedicated-decompressor aborts.
  perMessageDeflate: {
    compress: "dedicated",
    decompress: "shared",
  },
  // RPC clients ping every 5s. Reaping a connection after six missed ping
  // windows releases suspended-mobile sockets well before Bun's 120s default.
  idleTimeout: 30,
} as const;
