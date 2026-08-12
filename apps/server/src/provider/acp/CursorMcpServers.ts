// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { Effect } from "effect";

interface DiscoverCursorPluginDirectoriesOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
  readonly pluginsRoot?: string;
}

function resolveHome(environment: NodeJS.ProcessEnv, explicit: string | undefined): string {
  return explicit ?? environment.HOME ?? environment.USERPROFILE ?? "";
}

/** Finds cached Cursor plugins that declare MCP servers. */
export function discoverCursorPluginDirectories(
  options: DiscoverCursorPluginDirectoriesOptions = {},
): Effect.Effect<ReadonlyArray<string>> {
  return Effect.sync(() => {
    const environment = options.environment ?? process.env;
    const homeDirectory = resolveHome(environment, options.homeDirectory);
    const pluginsRoot =
      options.pluginsRoot ??
      NodePath.join(homeDirectory, ".cursor", "plugins", "cache", "cursor-public");
    if (!NodeFS.existsSync(pluginsRoot)) return [];

    const directories: string[] = [];
    for (const slug of NodeFS.readdirSync(pluginsRoot, { withFileTypes: true })) {
      if (!slug.isDirectory()) continue;
      const slugRoot = NodePath.join(pluginsRoot, slug.name);
      for (const version of NodeFS.readdirSync(slugRoot, { withFileTypes: true })) {
        if (!version.isDirectory()) continue;
        const pluginRoot = NodePath.join(slugRoot, version.name);
        if (
          NodeFS.existsSync(NodePath.join(pluginRoot, "mcp.json")) ||
          NodeFS.existsSync(NodePath.join(pluginRoot, ".mcp.json"))
        ) {
          directories.push(pluginRoot);
        }
      }
    }
    return directories.sort();
  });
}
