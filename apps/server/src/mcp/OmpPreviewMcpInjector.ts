/**
 * Process-private Cursor MCP overlay so an omp child can reach Pivot `/mcp`.
 *
 * Writes `{overlayHome}/.cursor/mcp.json` and returns spawn env (`HOME` +
 * `PI_CODING_AGENT_DIR`). Never writes user or project `mcp.json`.
 *
 * @module mcp/OmpPreviewMcpInjector
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import type { McpProviderSessionConfig } from "./McpProviderSession.ts";

const OVERLAY_CURSOR_DIR = ".cursor";
const OVERLAY_MCP_FILENAME = "mcp.json";
const PREVIEW_MCP_SERVER_NAME = "pivot-preview";
const OVERLAY_MCP_FILE_MODE = 0o600;

export class OmpPreviewMcpInjector {
  public constructor(
    private readonly fileSystem: FileSystem.FileSystem,
    private readonly path: Path.Path,
    private readonly overlayRoot: string,
  ) {}

  public install(
    threadId: ThreadId,
    config: McpProviderSessionConfig,
    agentDir: string,
  ): Effect.Effect<{ readonly extraEnv: Record<string, string> }> {
    return Effect.gen({ self: this }, function* () {
      const overlayHome = this.overlayHome(threadId);
      const cursorDir = this.path.join(overlayHome, OVERLAY_CURSOR_DIR);
      yield* this.fileSystem.makeDirectory(cursorDir, { recursive: true });
      yield* this.fileSystem.writeFileString(
        this.path.join(cursorDir, OVERLAY_MCP_FILENAME),
        this.overlayDocument(config),
        { mode: OVERLAY_MCP_FILE_MODE },
      );
      return {
        extraEnv: {
          HOME: overlayHome,
          PI_CODING_AGENT_DIR: agentDir,
        },
      };
    }).pipe(Effect.orDie);
  }

  public uninstall(threadId: ThreadId): Effect.Effect<void> {
    return this.fileSystem
      .remove(this.overlayHome(threadId), { recursive: true, force: true })
      .pipe(Effect.orDie);
  }

  private overlayHome(threadId: ThreadId): string {
    return this.path.join(this.overlayRoot, threadId);
  }

  private overlayDocument(config: McpProviderSessionConfig): string {
    return JSON.stringify({
      mcpServers: {
        [PREVIEW_MCP_SERVER_NAME]: {
          type: "http",
          url: config.endpoint,
          headers: { Authorization: config.authorizationHeader },
        },
      },
    });
  }
}
