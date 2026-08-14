import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { expect } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { OmpCapabilitiesError, ProjectId } from "@t3tools/contracts";
import * as ProcessRunner from "../../processRunner.ts";
import { ChildProcessSpawner } from "effect/unstable/process";
import { OmpConfigStore } from "./OmpConfigStore.ts";
import { OmpCapabilitiesService } from "./OmpCapabilitiesService.ts";

const OMP = "omp";

/** JSON string encoder for runner outputs / payload assertions (schema-based). */
const encodeJsonString = (value: unknown): string =>
  Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(value);

const emptyProcessOutput = (
  overrides: Partial<ProcessRunner.ProcessRunOutput> = {},
): ProcessRunner.ProcessRunOutput => ({
  stdout: "",
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
  ...overrides,
});

const LIST_JSON = {
  "theme.dark": { value: "titanium", type: "string", description: "Dark theme" },
  "auth.broker.token": { type: "string", description: "Broker token" },
  "advisor.enabled": { value: true, type: "boolean", description: "" },
  "power.sleepPrevention": { value: "idle", type: "enum", description: "" },
};

function makeRunner(options: {
  readonly agentDir: string;
  readonly listJson?: Record<string, unknown>;
}) {
  const calls: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];
  const runner = ProcessRunner.ProcessRunner.of({
    run: (input): Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError> =>
      Effect.sync(() => {
        calls.push({ command: input.command, args: [...input.args] });
        const key = `${input.command} ${input.args.join(" ")}`;
        if (key === `${OMP} config path`) {
          return emptyProcessOutput({ stdout: options.agentDir });
        }
        if (key === `${OMP} config list --json`) {
          return emptyProcessOutput({ stdout: encodeJsonString(options.listJson ?? LIST_JSON) });
        }
        if (input.args[0] === "config") {
          // set/reset succeed by default
          return emptyProcessOutput();
        }
        return emptyProcessOutput({
          code: ChildProcessSpawner.ExitCode(1),
          stderr: `unknown command ${key}`,
        });
      }),
  });
  return { runner, calls };
}

function makeService(options: {
  readonly agentDir: string;
  readonly projectCwd?: string;
  readonly runner: ProcessRunner.ProcessRunner["Service"];
  readonly listJson?: Record<string, unknown>;
  readonly configStore?: OmpConfigStore;
}) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const store = options.configStore ?? new OmpConfigStore(fs, path, options.agentDir);
    const service = new OmpCapabilitiesService(fs, path, OMP, options.runner, store, (projectId) =>
      Effect.sync(() => {
        if (options.projectCwd === undefined) {
          throw new Error(`unexpected projectId ${projectId}`);
        }
        return options.projectCwd;
      }),
    );
    return service;
  });
}

it.layer(NodeServices.layer)("OmpCapabilitiesService", (it) => {
  it.effect("resolves the agent dir from omp config path and inventories resources", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-agent-" });
      yield* fs.makeDirectory(path.join(agentDir, "skills"), { recursive: true });
      yield* fs.writeFileString(path.join(agentDir, "config.yml"), "autoResume: false\n");

      const { runner } = makeRunner({ agentDir });
      const service = yield* makeService({ agentDir, runner });

      const snapshot = yield* service.getSnapshot();

      // Temp agent dir is not under the user home, so the display-only label
      // stays absent — and no absolute host path leaks into the payload.
      expect(snapshot.agentDirLabel).toBeUndefined();
      const config = snapshot.resources.find((r) => r.kind === "config");
      expect(config?.exists).toBe(true);
      expect(config?.provenance).toBe("global");
      const skills = snapshot.resources.find((r) => r.kind === "skills");
      expect(skills?.exists).toBe(true);
      const models = snapshot.resources.find((r) => r.kind === "models");
      expect(models?.exists).toBe(false);
      // No absolute host paths on the wire.
      expect(encodeJsonString(snapshot)).not.toContain(agentDir);
    }),
  );

  it.effect("fails closed when omp config path fails (no env-var fallback)", () =>
    Effect.gen(function* () {
      const runner = ProcessRunner.ProcessRunner.of({
        run: () =>
          Effect.sync(() =>
            emptyProcessOutput({ code: ChildProcessSpawner.ExitCode(1), stderr: "not found" }),
          ),
      });
      const service = yield* makeService({ agentDir: "/unused", runner });
      const failure = yield* service.getSnapshot().pipe(Effect.flip);
      expect(failure._tag).toBe("OmpCapabilitiesError");
      expect(failure.reason).toContain("not found");
    }),
  );

  it.effect("inventories project scope from a trusted projectId resolver", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-agent-" });
      const projectCwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-project-" });
      yield* fs.makeDirectory(path.join(projectCwd, ".omp", "skills"), { recursive: true });

      const { runner } = makeRunner({ agentDir });
      const service = yield* makeService({ agentDir, projectCwd, runner });

      const snapshot = yield* service.getSnapshot(ProjectId.make("project-1"));
      const projectSkills = snapshot.resources.find(
        (r) => r.kind === "skills" && r.scope === "project",
      );
      expect(projectSkills?.exists).toBe(true);
      expect(projectSkills?.provenance).toBe("project");
    }),
  );

  it.effect("exposes the settings surface from omp config list --json with masked secrets", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-agent-" });
      const { runner } = makeRunner({ agentDir });
      const service = yield* makeService({ agentDir, runner });

      const snapshot = yield* service.getSnapshot();
      const theme = snapshot.settings.entries.find((e) => e.key === "theme.dark");
      expect(theme?.value).toBe("titanium");
      expect(theme?.masked).toBe(false);
      const token = snapshot.settings.entries.find((e) => e.key === "auth.broker.token");
      expect(token?.masked).toBe(true);
      expect(token?.value).toBe("********");
      // Secrets never appear in the payload.
      expect(encodeJsonString(snapshot)).not.toContain("broker-token-value");
    }),
  );

  it.effect("writes global settings through omp config set", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-agent-" });
      const { runner, calls } = makeRunner({ agentDir });
      const service = yield* makeService({ agentDir, runner });

      const snapshot = yield* service.writeSetting({
        key: "theme.dark",
        value: "midnight",
        scope: "global",
      });
      expect(snapshot.settings.entries.length).toBeGreaterThan(0);
      const setCall = calls.find((c) => c.args[0] === "config" && c.args[1] === "set");
      expect(setCall?.args).toEqual(["config", "set", "theme.dark", "midnight"]);
    }),
  );

  it.effect("writes project settings via comment-preserving merge with a .bak backup", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-agent-" });
      const projectCwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-project-" });
      const ompDir = path.join(projectCwd, ".omp");
      yield* fs.makeDirectory(ompDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(ompDir, "config.yml"),
        "# user comment\nautoResume: false\n",
      );

      const { runner } = makeRunner({ agentDir });
      const service = yield* makeService({ agentDir, projectCwd, runner });

      yield* service.writeSetting({
        key: "autoResume",
        value: true,
        scope: "project",
        projectId: ProjectId.make("project-1"),
      });

      const text = yield* fs.readFileString(path.join(ompDir, "config.yml"));
      expect(text).toContain("# user comment");
      expect(text).toContain("autoResume: true");
      const backups = yield* fs.readDirectory(ompDir);
      expect(backups.some((name) => name.startsWith("config.yml.bak-"))).toBe(true);
    }),
  );

  it.effect("rejects project writes without a projectId", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-agent-" });
      const { runner } = makeRunner({ agentDir });
      const service = yield* makeService({ agentDir, runner });

      const failure = yield* service
        .writeSetting({ key: "autoResume", value: true, scope: "project" })
        .pipe(Effect.flip);
      expect(failure._tag).toBe("OmpCapabilitiesError");
    }),
  );

  it.effect("resets global settings through omp config reset only with confirm", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-agent-" });
      const { runner, calls } = makeRunner({ agentDir });
      const service = yield* makeService({ agentDir, runner });

      const unconfirmed = yield* service
        .resetSetting({ key: "theme.dark", scope: "global", confirm: false })
        .pipe(Effect.flip);
      expect(unconfirmed._tag).toBe("OmpCapabilitiesError");
      expect(unconfirmed.reason).toContain("confirm");

      yield* service.resetSetting({ key: "theme.dark", scope: "global", confirm: true });
      const resetCall = calls.find((c) => c.args[0] === "config" && c.args[1] === "reset");
      expect(resetCall?.args).toEqual(["config", "reset", "theme.dark"]);
    }),
  );

  it.effect("resets project settings by deleting the key after a backup", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-agent-" });
      const projectCwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-project-" });
      const ompDir = path.join(projectCwd, ".omp");
      yield* fs.makeDirectory(ompDir, { recursive: true });
      yield* fs.writeFileString(path.join(ompDir, "config.yml"), "autoResume: true\nother: x\n");

      const { runner } = makeRunner({ agentDir });
      const service = yield* makeService({ agentDir, projectCwd, runner });

      yield* service.resetSetting({
        key: "autoResume",
        scope: "project",
        projectId: ProjectId.make("project-1"),
        confirm: true,
      });

      const text = yield* fs.readFileString(path.join(ompDir, "config.yml"));
      expect(text).not.toContain("autoResume");
      expect(text).toContain("other: x");
    }),
  );

  it.effect("reports env and models resources write-only (hasValue / masked, no contents)", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-agent-" });
      yield* fs.writeFileString(path.join(agentDir, ".env"), "ANTHROPIC_API_KEY=super-secret\n");
      yield* fs.writeFileString(path.join(agentDir, "models.yml"), "apiKey: another-secret\n");

      const { runner } = makeRunner({ agentDir });
      const service = yield* makeService({ agentDir, runner });

      const snapshot = yield* service.getSnapshot();
      const env = snapshot.resources.find((r) => r.kind === "env");
      expect(env?.hasValue).toBe(true);
      const models = snapshot.resources.find((r) => r.kind === "models");
      expect(models?.masked).toBe(true);
      const payload = encodeJsonString(snapshot);
      expect(payload).not.toContain("super-secret");
      expect(payload).not.toContain("another-secret");
    }),
  );

  it.effect("fails closed when omp config list fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-agent-" });
      const runner = ProcessRunner.ProcessRunner.of({
        run: (input) =>
          Effect.sync(() =>
            input.args.includes("path")
              ? emptyProcessOutput({ stdout: agentDir })
              : emptyProcessOutput({
                  code: ChildProcessSpawner.ExitCode(1),
                  stderr: "list failed",
                }),
          ),
      });
      const service = yield* makeService({ agentDir, runner });
      const failure = yield* service.getSnapshot().pipe(Effect.flip);
      expect(failure._tag).toBe("OmpCapabilitiesError");
    }),
  );

  const isError = Schema.is(OmpCapabilitiesError);
  it.effect("surfaces typed OmpCapabilitiesError instances", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-agent-" });
      const runner = ProcessRunner.ProcessRunner.of({
        run: () =>
          Effect.sync(() =>
            emptyProcessOutput({ code: ChildProcessSpawner.ExitCode(1), stderr: "boom" }),
          ),
      });
      const service = yield* makeService({ agentDir, runner });
      const failure = yield* service.getSnapshot().pipe(Effect.flip);
      expect(isError(failure)).toBe(true);
    }),
  );
});
