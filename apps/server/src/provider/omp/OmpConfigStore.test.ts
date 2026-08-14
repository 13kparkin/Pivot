import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { expect } from "vite-plus/test";

import { OmpConfigStore } from "./OmpConfigStore.ts";

it.layer(NodeServices.layer)("OmpConfigStore", (it) => {
  it.effect("round-trips modelRoles.plan and advisor.enabled in a temp omp home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const ompHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-config-store-" });
      const store = new OmpConfigStore(fs, path, ompHome);

      const missing = yield* store.read();
      expect(missing.modelRoles).toEqual({});
      expect(missing.advisor).toBeUndefined();

      yield* store.write({
        modelRoles: { plan: "anthropic/claude-plan" },
        advisor: { enabled: true },
      });

      const loaded = yield* store.read();
      expect(loaded.modelRoles.plan).toBe("anthropic/claude-plan");
      expect(loaded.advisor?.enabled).toBe(true);
    }),
  );

  it.effect("writes config.yml directly inside the agent dir (omp config path semantics)", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-agent-" });
      const store = new OmpConfigStore(fs, path, agentDir);

      yield* store.write({ memoryBackend: "sqlite" });

      // The store state IS the agent dir — `omp config path` returns the agent
      // dir itself, so config.yml sits at agentDir/config.yml, never
      // agentDir/agent/config.yml.
      const configPath = path.join(agentDir, "config.yml");
      expect(yield* fs.exists(configPath)).toBe(true);
      expect(yield* fs.exists(path.join(agentDir, "agent", "config.yml"))).toBe(false);
    }),
  );

  it.effect("forAgentDir scopes reads and writes to the resolved agent dir", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-scope-" });
      const first = path.join(base, "first");
      const second = path.join(base, "second");
      yield* fs.makeDirectory(first, { recursive: true });
      yield* fs.makeDirectory(second, { recursive: true });

      const store = new OmpConfigStore(fs, path, base);
      const firstView = store.forAgentDir(first);
      const secondView = store.forAgentDir(second);

      yield* firstView.write({ modelRoles: { plan: "anthropic/claude-plan" } });
      yield* secondView.write({ modelRoles: { slow: "anthropic/claude-slow" } });

      const firstLoaded = yield* firstView.read();
      expect(firstLoaded.modelRoles.plan).toBe("anthropic/claude-plan");
      expect(firstLoaded.modelRoles.slow).toBeUndefined();
      const secondLoaded = yield* secondView.read();
      expect(secondLoaded.modelRoles.slow).toBe("anthropic/claude-slow");
      expect(secondLoaded.modelRoles.plan).toBeUndefined();
    }),
  );

  it.effect("writeProjectKey writes into <projectCwd>/.omp/config.yml preserving comments", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectCwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-project-" });
      const ompDir = path.join(projectCwd, ".omp");
      yield* fs.makeDirectory(ompDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(ompDir, "config.yml"),
        ["# keep this comment", "autoResume: false", "unknownKey: keep-me", ""].join("\n"),
      );

      const store = new OmpConfigStore(fs, path, projectCwd);
      yield* store.writeProjectKey(projectCwd, "autoResume", true);

      const text = yield* fs.readFileString(path.join(ompDir, "config.yml"));
      expect(text).toContain("# keep this comment");
      expect(text).toContain("unknownKey: keep-me");
      expect(text).toContain("autoResume: true");
    }),
  );

  it.effect("writeProjectKey creates the project .omp config when absent", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectCwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-project-" });

      const store = new OmpConfigStore(fs, path, projectCwd);
      yield* store.writeProjectKey(projectCwd, "theme.dark", "titanium");

      const configPath = path.join(projectCwd, ".omp", "config.yml");
      expect(yield* fs.exists(configPath)).toBe(true);
      const text = yield* fs.readFileString(configPath);
      // setIn writes nested YAML (theme.dark -> theme: dark:) — the value must
      // survive a YAML round-trip, which is how omp reads config.yml.
      expect(text).toContain("dark: titanium");
    }),
  );

  it.effect("writeProjectKey removes the key when value is undefined", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectCwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-project-" });
      const ompDir = path.join(projectCwd, ".omp");
      yield* fs.makeDirectory(ompDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(ompDir, "config.yml"),
        "autoResume: true\nother: stays\n",
      );

      const store = new OmpConfigStore(fs, path, projectCwd);
      yield* store.writeProjectKey(projectCwd, "autoResume", undefined);

      const text = yield* fs.readFileString(path.join(ompDir, "config.yml"));
      expect(text).not.toContain("autoResume");
      expect(text).toContain("other: stays");
    }),
  );
});
