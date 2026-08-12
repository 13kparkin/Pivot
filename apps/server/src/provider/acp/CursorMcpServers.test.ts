// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { addCursorPluginDirectories, buildCursorAcpSpawnInput } from "./CursorAcpSupport.ts";
import { discoverCursorPluginDirectories } from "./CursorMcpServers.ts";

const writePlugin = Effect.fn("writePlugin")(function* (pluginsRoot: string, slug: string) {
  const pluginRoot = NodePath.join(pluginsRoot, slug, "hash");
  yield* Effect.promise(() =>
    NodeFSP.mkdir(NodePath.join(pluginRoot, ".cursor-plugin"), { recursive: true }),
  );
  yield* Effect.promise(() =>
    NodeFSP.writeFile(
      NodePath.join(pluginRoot, ".cursor-plugin", "plugin.json"),
      `{"name":"${slug}"}`,
    ),
  );
  yield* Effect.promise(() =>
    NodeFSP.writeFile(NodePath.join(pluginRoot, "mcp.json"), '{"mcpServers":{}}'),
  );
  return pluginRoot;
});

describe("discoverCursorPluginDirectories", () => {
  it.effect("returns cached Cursor plugins that provide MCP servers", () =>
    Effect.gen(function* () {
      const temp = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp("/tmp/t3-cursor-mcp-")),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const pluginsRoot = NodePath.join(temp, "plugins", "cache", "cursor-public");
      const paperRoot = yield* writePlugin(pluginsRoot, "paper-desktop");
      const noMcpRoot = NodePath.join(pluginsRoot, "no-mcp", "hash");
      yield* Effect.promise(() =>
        NodeFSP.mkdir(NodePath.join(noMcpRoot, ".cursor-plugin"), { recursive: true }),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(noMcpRoot, ".cursor-plugin", "plugin.json"),
          '{"name":"no-mcp"}',
        ),
      );

      const directories = yield* discoverCursorPluginDirectories({ pluginsRoot });

      expect(directories).toEqual([paperRoot]);

      const spawn = buildCursorAcpSpawnInput(null, "/workspace");
      expect(addCursorPluginDirectories(spawn, directories).args).toEqual([
        "--plugin-dir",
        paperRoot,
        "acp",
      ]);
    }).pipe(Effect.scoped),
  );
});
