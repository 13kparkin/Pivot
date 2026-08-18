import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { McpProviderSessionConfig } from "./McpProviderSession.ts";
import { OmpPreviewMcpInjector } from "./OmpPreviewMcpInjector.ts";

const THREAD_ID = ThreadId.make("thread-preview-1");
const AGENT_DIR = "/tmp/pivot-agent-dir";

const OverlayMcpJson = Schema.Struct({
  mcpServers: Schema.Struct({
    "pivot-preview": Schema.Struct({
      type: Schema.Literal("http"),
      url: Schema.String,
      headers: Schema.Struct({
        Authorization: Schema.String,
      }),
    }),
  }),
});

const decodeOverlayMcpJson = Schema.decodeSync(Schema.fromJsonString(OverlayMcpJson));

const sessionConfig: McpProviderSessionConfig = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: THREAD_ID,
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("omp"),
  endpoint: "http://127.0.0.1:43123/mcp",
  authorizationHeader: "Bearer test-preview-token",
};

it.layer(NodeServices.layer)("OmpPreviewMcpInjector", (it) => {
  it.effect(
    "Given a minted MCP session, When install runs, Then overlay mcp.json is pivot-preview HTTP with Authorization",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const overlayRoot = yield* fs.makeTempDirectoryScoped({ prefix: "pivot-preview-mcp-" });
        const injector = new OmpPreviewMcpInjector(fs, path, overlayRoot);

        yield* injector.install(THREAD_ID, sessionConfig, AGENT_DIR);

        const overlayPath = path.join(overlayRoot, THREAD_ID, ".cursor", "mcp.json");
        const raw = yield* fs.readFileString(overlayPath);
        expect(decodeOverlayMcpJson(raw)).toEqual({
          mcpServers: {
            "pivot-preview": {
              type: "http",
              url: sessionConfig.endpoint,
              headers: { Authorization: sessionConfig.authorizationHeader },
            },
          },
        });
      }),
  );

  it.effect(
    "Given a minted MCP session, When install runs, Then extraEnv sets HOME to the overlay and PI_CODING_AGENT_DIR to the agent dir",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const overlayRoot = yield* fs.makeTempDirectoryScoped({ prefix: "pivot-preview-mcp-" });
        const injector = new OmpPreviewMcpInjector(fs, path, overlayRoot);

        const installed = yield* injector.install(THREAD_ID, sessionConfig, AGENT_DIR);

        expect(installed.extraEnv).toEqual({
          HOME: path.join(overlayRoot, THREAD_ID),
          PI_CODING_AGENT_DIR: AGENT_DIR,
        });
      }),
  );

  it.effect(
    "Given an installed overlay, When uninstall runs, Then the overlay directory is gone",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const overlayRoot = yield* fs.makeTempDirectoryScoped({ prefix: "pivot-preview-mcp-" });
        const injector = new OmpPreviewMcpInjector(fs, path, overlayRoot);
        yield* injector.install(THREAD_ID, sessionConfig, AGENT_DIR);
        const overlayHome = path.join(overlayRoot, THREAD_ID);

        yield* injector.uninstall(THREAD_ID);

        expect(yield* fs.exists(overlayHome)).toBe(false);
      }),
  );
});
