import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { afterEach, expect, vi } from "vite-plus/test";
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

/** Human `omp config list` output; enum entries carry choices in the type column. */
const HUMAN_LIST = [
  "  theme.dark = titanium (string)",
  "  auth.broker.token = ******** (string)",
  "  advisor.enabled = true (boolean)",
  "  power.sleepPrevention = idle (off|idle|display|system)",
].join("\n");

function makeRunner(options: {
  readonly agentDir: string;
  readonly listJson?: Record<string, unknown>;
  readonly humanList?: string;
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
        if (key === `${OMP} config list`) {
          return emptyProcessOutput({ stdout: options.humanList ?? HUMAN_LIST });
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
  readonly listProjectWorkspaces?: ReadonlyArray<{
    readonly projectId: ProjectId;
    readonly cwd: string;
    readonly title: string;
  }>;
}) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const store = options.configStore ?? new OmpConfigStore(fs, path, options.agentDir);
    const workspaces = options.listProjectWorkspaces;
    const service = new OmpCapabilitiesService(
      fs,
      path,
      OMP,
      options.runner,
      store,
      (projectId) =>
        Effect.sync(() => {
          if (options.projectCwd === undefined) {
            throw new Error(`unexpected projectId ${projectId}`);
          }
          return options.projectCwd;
        }),
      workspaces === undefined
        ? undefined
        : () =>
            Effect.sync(() =>
              workspaces.map((workspace) => ({
                projectId: workspace.projectId,
                cwd: workspace.cwd,
                title: workspace.title,
              })),
            ),
    );
    return service;
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

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

  it.effect("attaches enum choices parsed from the human config list", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-agent-" });
      const { runner } = makeRunner({ agentDir });
      const service = yield* makeService({ agentDir, runner });

      const snapshot = yield* service.getSnapshot();
      const sleep = snapshot.settings.entries.find((e) => e.key === "power.sleepPrevention");
      expect(sleep?.values).toEqual(["off", "idle", "display", "system"]);
      const theme = snapshot.settings.entries.find((e) => e.key === "theme.dark");
      expect(theme?.values).toBeUndefined();
    }),
  it.effect(
    "project snapshots surface the project's own config layer as project-scoped settings",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-agent-" });
        const projectCwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-project-" });
        yield* fs.makeDirectory(path.join(projectCwd, ".omp"), { recursive: true });
        yield* fs.writeFileString(
          path.join(projectCwd, ".omp", "config.yml"),
          "autoResume: false\nmodelRoles:\n  default: gpt-5.6\nthreadCount: 4\ncustom.unknownKey: hello\n",
        );

        const { runner } = makeRunner({ agentDir });
        const service = yield* makeService({ agentDir, projectCwd, runner });

        const snapshot = yield* service.getSnapshot(ProjectId.make("project-1"));
        const byKey = new Map(snapshot.settings.entries.map((entry) => [entry.key, entry]));
        expect(byKey.get("autoResume")).toMatchObject({
          value: false,
          type: "boolean",
          scope: "project",
        });
        expect(byKey.get("modelRoles.default")).toMatchObject({
          value: "gpt-5.6",
          type: "string",
          scope: "project",
        });
        expect(byKey.get("threadCount")).toMatchObject({
          value: 4,
          type: "number",
          scope: "project",
        });
        // Effective/global settings stay visible, tagged by their origin:
        // the project layer tags the keys it overrides, everything else is
        // tagged global so the project view can label + move them.
        expect(byKey.get("theme.dark")).toMatchObject({ scope: "global" });
        // Project-only unknown keys still surface as project-scoped.
        expect(byKey.get("custom.unknownKey")).toMatchObject({ scope: "project" });

        // A project write lands in the layer and shows up in the next snapshot.
        yield* service.writeSetting({
          key: "retry.enabled",
          value: true,
          scope: "project",
          projectId: ProjectId.make("project-1"),
        });
        const after = yield* service.getSnapshot(ProjectId.make("project-1"));
        expect(
          new Map(after.settings.entries.map((e) => [e.key, e])).get("retry.enabled"),
        ).toMatchObject({ value: true, scope: "project" });

        // The global snapshot still returns the effective CLI list.
        const globalSnapshot = yield* service.getSnapshot();
        expect(globalSnapshot.settings.entries.some((entry) => entry.key === "theme.dark")).toBe(
          true,
        );
        expect(globalSnapshot.settings.entries.every((entry) => entry.scope === "global")).toBe(
          true,
        );
      }),
  );

  it.effect("inventories skills from cursor-compatible roots on the server host", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-agent-" });
      yield* fs.makeDirectory(path.join(agentDir, "skills", "agent-skill"), { recursive: true });
      yield* fs.writeFileString(
        path.join(agentDir, "skills", "agent-skill", "SKILL.md"),
        "# Agent skill\n",
      );
      // Cursor-compatible roots, keyed off the stubbed home dir.
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-home-" });
      yield* fs.makeDirectory(path.join(home, ".cursor", "skills", "cursor-skill"), {
        recursive: true,
      });
      yield* fs.writeFileString(
        path.join(home, ".cursor", "skills", "cursor-skill", "SKILL.md"),
        "---\ndescription: From cursor\n---\n",
      );
      yield* fs.makeDirectory(path.join(home, ".cursor", "skills-cursor", "bundled-skill"), {
        recursive: true,
      });
      yield* fs.writeFileString(
        path.join(home, ".cursor", "skills-cursor", "bundled-skill", "SKILL.md"),
        "# Bundled\n",
      );
      vi.stubEnv("HOME", home);

      const { runner } = makeRunner({ agentDir });
      const service = yield* makeService({ agentDir, runner });
      const snapshot = yield* service.getSnapshot();
      const names = snapshot.skills.map((skill) => skill.name);
      expect(names).toContain("agent-skill");
      expect(names).toContain("cursor-skill");
      expect(names).toContain("bundled-skill");
      const cursorSkill = snapshot.skills.find((skill) => skill.name === "cursor-skill");
      expect(cursorSkill?.description).toBe("From cursor");
    }),
  );

  it.effect(
    "tags foreign-root skills with their source and moves them into the omp agent dir",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-agent-" });
        yield* fs.makeDirectory(path.join(agentDir, "skills"), { recursive: true });
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-home-" });
        const cursorRoot = path.join(home, ".cursor", "skills");
        yield* fs.makeDirectory(path.join(cursorRoot, "import-me", "agents"), { recursive: true });
        yield* fs.writeFileString(path.join(cursorRoot, "import-me", "SKILL.md"), "# Import me\n");
        yield* fs.writeFileString(
          path.join(cursorRoot, "import-me", "agents", "helper.md"),
          "# Helper\n",
        );
        vi.stubEnv("HOME", home);

        const { runner } = makeRunner({ agentDir });
        const service = yield* makeService({ agentDir, runner });

        const before = yield* service.getSnapshot();
        const foreign = before.skills.find((skill) => skill.name === "import-me");
        expect(foreign?.scope).toBe("global");
        expect(foreign?.sourceDir).toBe("~/.cursor/skills");

        const after = yield* service.moveItemToOmp({ kind: "skills", name: "import-me" });
        const moved = after.skills.find((skill) => skill.name === "import-me");
        expect(moved?.sourceDir).toBeUndefined();

        // Files physically moved: present in the agent dir, gone from cursor.
        const movedSkill = yield* fs.readFileString(
          path.join(agentDir, "skills", "import-me", "SKILL.md"),
        );
        expect(movedSkill).toContain("Import me");
        const helper = yield* fs.readFileString(
          path.join(agentDir, "skills", "import-me", "agents", "helper.md"),
        );
        expect(helper).toContain("Helper");
        expect(yield* fs.exists(path.join(cursorRoot, "import-me"))).toBe(false);
      }),
  );

  it.effect(
    "inventories skills and rules across every project when includeAllProjects is set",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-agent-" });
        yield* fs.makeDirectory(path.join(agentDir, "skills", "global-skill"), { recursive: true });
        yield* fs.writeFileString(
          path.join(agentDir, "skills", "global-skill", "SKILL.md"),
          "# Global\n",
        );
        const projectA = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-proj-a-" });
        yield* fs.makeDirectory(path.join(projectA, ".omp", "skills", "proj-a-skill"), {
          recursive: true,
        });
        yield* fs.writeFileString(
          path.join(projectA, ".omp", "skills", "proj-a-skill", "SKILL.md"),
          "# A\n",
        );
        yield* fs.makeDirectory(path.join(projectA, ".omp", "rules"), { recursive: true });
        yield* fs.writeFileString(path.join(projectA, ".omp", "rules", "proj-a-rule.md"), "# AR\n");
        const projectB = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-proj-b-" });
        yield* fs.makeDirectory(path.join(projectB, ".omp", "skills", "proj-b-skill"), {
          recursive: true,
        });
        yield* fs.writeFileString(
          path.join(projectB, ".omp", "skills", "proj-b-skill", "SKILL.md"),
          "# B\n",
        );

        const { runner } = makeRunner({ agentDir });
        const service = yield* makeService({
          agentDir,
          runner,
          listProjectWorkspaces: [
            { projectId: ProjectId.make("project-a"), cwd: projectA, title: "Project A" },
            { projectId: ProjectId.make("project-b"), cwd: projectB, title: "Project B" },
          ],
        });

        const snapshot = yield* service.getSnapshot(undefined, { includeAllProjects: true });
        const skillNames = new Map(snapshot.skills.map((skill) => [skill.name, skill]));
        expect(skillNames.has("global-skill")).toBe(true);
        expect(skillNames.get("proj-a-skill")).toMatchObject({
          scope: "project",
          projectId: ProjectId.make("project-a"),
          projectTitle: "Project A",
        });
        expect(skillNames.get("proj-b-skill")).toMatchObject({
          scope: "project",
          projectId: ProjectId.make("project-b"),
          projectTitle: "Project B",
        });
        const rule = snapshot.rules.find((item) => item.name === "proj-a-rule");
        expect(rule).toMatchObject({
          scope: "project",
          projectId: ProjectId.make("project-a"),
          projectTitle: "Project A",
        });

        // A single-project snapshot stays scoped to that project.
        const single = yield* service.getSnapshot(ProjectId.make("project-a"));
        const singleSkills = single.skills.map((skill) => skill.name);
        expect(singleSkills).toContain("proj-a-skill");
        expect(singleSkills).not.toContain("proj-b-skill");
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

  it.effect("serializes structured global values as JSON for omp config set", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-agent-" });
      const { runner, calls } = makeRunner({ agentDir });
      const service = yield* makeService({ agentDir, runner });

      yield* service.writeSetting({
        key: "modelRoles",
        value: { default: "openai/gpt-5" },
        scope: "global",
      });
      const setCall = calls.find((c) => c.args[0] === "config" && c.args[1] === "set");
      expect(setCall?.args).toEqual(["config", "set", "modelRoles", '{"default":"openai/gpt-5"}']);
  it.effect("parses raw string values into typed scalars for project-scope writes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-agent-" });
      const projectCwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-project-" });
      yield* fs.makeDirectory(path.join(projectCwd, ".omp"), { recursive: true });

      const { runner } = makeRunner({ agentDir });
      const service = yield* makeService({ agentDir, projectCwd, runner });

      yield* service.writeSetting({
        key: "autoResume",
        value: "false",
        scope: "project",
        projectId: ProjectId.make("project-1"),
      });
      yield* service.writeSetting({
        key: "threadCount",
        value: "4",
        scope: "project",
        projectId: ProjectId.make("project-1"),
      });
      yield* service.writeSetting({
        key: "theme.dark",
        value: "titanium",
        scope: "project",
        projectId: ProjectId.make("project-1"),
      });

      const snapshot = yield* service.getSnapshot(ProjectId.make("project-1"));
      const byKey = new Map(snapshot.settings.entries.map((entry) => [entry.key, entry]));
      expect(byKey.get("autoResume")?.value).toBe(false);
      expect(byKey.get("threadCount")?.value).toBe(4);
      expect(byKey.get("theme.dark")?.value).toBe("titanium");

      // The file stores typed scalars, not quoted strings.
      const text = yield* fs.readFileString(path.join(projectCwd, ".omp", "config.yml"));
      expect(text).toContain("autoResume: false");
      expect(text).toContain("threadCount: 4");
      expect(text).toContain("dark: titanium");
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

  it.effect("inventories rule and skill items with frontmatter descriptions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-agent-" });
      yield* fs.makeDirectory(path.join(agentDir, "rules"), { recursive: true });
      yield* fs.writeFileString(
        path.join(agentDir, "rules", "codegraph.md"),
        '---\ndescription: "Prefer CodeGraph before grep"\n---\n\nBody',
      );
      // Non-markdown files and the support bundle are not rules.
      yield* fs.writeFileString(path.join(agentDir, "rules", "notes.txt"), "ignored");
      yield* fs.makeDirectory(path.join(agentDir, "rules", "support"), { recursive: true });
      yield* fs.makeDirectory(path.join(agentDir, "skills", "create-ticket"), { recursive: true });
      yield* fs.writeFileString(
        path.join(agentDir, "skills", "create-ticket", "SKILL.md"),
        '---\nname: create-ticket\ndescription: "Drafting a ticket"\n---\n\nBody',
      );
      // Skill dirs without SKILL.md are not skills.
      yield* fs.makeDirectory(path.join(agentDir, "skills", "draft"), { recursive: true });

      // Isolate from the real home's cursor-compatible skill roots so the
      // exact-list assertions below are deterministic.
      const isolatedHome = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-isolated-home-" });
      vi.stubEnv("HOME", isolatedHome);

      const { runner } = makeRunner({ agentDir });
      const service = yield* makeService({ agentDir, runner });

      const snapshot = yield* service.getSnapshot();
      expect(snapshot.rules.map((item) => item.name)).toEqual(["codegraph"]);
      expect(snapshot.rules[0]?.description).toBe("Prefer CodeGraph before grep");
      expect(snapshot.skills.map((item) => item.name)).toEqual(["create-ticket"]);
      expect(snapshot.skills[0]?.description).toBe("Drafting a ticket");
      // No absolute host paths on the wire.
      expect(encodeJsonString(snapshot)).not.toContain(agentDir);
    }),
  );

  it.effect("inventories project items under the project .omp folder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-agent-" });
      const projectCwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-project-" });
      yield* fs.makeDirectory(path.join(projectCwd, ".omp", "rules"), { recursive: true });
      yield* fs.writeFileString(
        path.join(projectCwd, ".omp", "rules", "project-only.md"),
        '---\ndescription: "Project rule"\n---\n',
      );

      const { runner } = makeRunner({ agentDir });
      const service = yield* makeService({ agentDir, projectCwd, runner });

      const snapshot = yield* service.getSnapshot(ProjectId.make("project-1"));
      const projectRule = snapshot.rules.find((item) => item.scope === "project");
      expect(projectRule?.name).toBe("project-only");
      expect(projectRule?.description).toBe("Project rule");
    }),
  );

  it.effect("reads a rule file and reports missing items as exists: false", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-agent-" });
      yield* fs.makeDirectory(path.join(agentDir, "rules"), { recursive: true });
      yield* fs.writeFileString(path.join(agentDir, "rules", "codegraph.md"), "# rule body");

      const { runner } = makeRunner({ agentDir });
      const service = yield* makeService({ agentDir, runner });

      const existing = yield* service.readResource({
        kind: "rules",
        name: "codegraph",
        scope: "global",
      });
      expect(existing).toEqual({
        name: "codegraph",
        scope: "global",
        content: "# rule body",
        exists: true,
      });
      const missing = yield* service.readResource({
        kind: "rules",
        name: "nope",
        scope: "global",
      });
      expect(missing.exists).toBe(false);
      expect(missing.content).toBe("");
    }),
  );

  it.effect("creates a rule and a skill, and rejects overwriting without overwrite: true", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-agent-" });
      yield* fs.makeDirectory(path.join(agentDir, "rules"), { recursive: true });
      yield* fs.writeFileString(path.join(agentDir, "rules", "codegraph.md"), "old");

      const { runner } = makeRunner({ agentDir });
      const service = yield* makeService({ agentDir, runner });

      const collide = yield* service
        .writeResource({
          kind: "rules",
          name: "codegraph",
          content: "new",
          scope: "global",
          overwrite: false,
        })
        .pipe(Effect.flip);
      expect(collide._tag).toBe("OmpCapabilitiesError");
      expect(collide.reason).toContain("already exists");

      yield* service.writeResource({
        kind: "rules",
        name: "codegraph",
        content: "new",
        scope: "global",
        overwrite: true,
      });
      const ruleText = yield* fs.readFileString(path.join(agentDir, "rules", "codegraph.md"));
      expect(ruleText).toBe("new");

      yield* service.writeResource({
        kind: "skills",
        name: "create-ticket",
        content: "# body",
        scope: "global",
        overwrite: false,
      });
      const skillText = yield* fs.readFileString(
        path.join(agentDir, "skills", "create-ticket", "SKILL.md"),
      );
      expect(skillText).toBe("# body");
    }),
  );

  it.effect("writes project items after a .bak backup and requires a projectId", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-agent-" });
      const projectCwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-project-" });
      const rulesDir = path.join(projectCwd, ".omp", "rules");
      yield* fs.makeDirectory(rulesDir, { recursive: true });
      yield* fs.writeFileString(path.join(rulesDir, "codegraph.md"), "old");

      const { runner } = makeRunner({ agentDir });
      const service = yield* makeService({ agentDir, projectCwd, runner });

      const noProject = yield* service
        .writeResource({
          kind: "rules",
          name: "codegraph",
          content: "new",
          scope: "project",
          overwrite: true,
        })
        .pipe(Effect.flip);
      expect(noProject._tag).toBe("OmpCapabilitiesError");

      yield* service.writeResource({
        kind: "rules",
        name: "codegraph",
        content: "new",
        scope: "project",
        projectId: ProjectId.make("project-1"),
        overwrite: true,
      });
      const ruleText = yield* fs.readFileString(path.join(rulesDir, "codegraph.md"));
      expect(ruleText).toBe("new");
      const backups = yield* fs.readDirectory(rulesDir);
      expect(backups.some((name) => name.startsWith("codegraph.md.bak-"))).toBe(true);
    }),
  );

  it.effect("deletes rules and skill directories only with confirm", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-agent-" });
      yield* fs.makeDirectory(path.join(agentDir, "rules"), { recursive: true });
      yield* fs.writeFileString(path.join(agentDir, "rules", "codegraph.md"), "body");
      yield* fs.makeDirectory(path.join(agentDir, "skills", "create-ticket"), { recursive: true });
      yield* fs.writeFileString(
        path.join(agentDir, "skills", "create-ticket", "SKILL.md"),
        "# body",
      );

      const { runner } = makeRunner({ agentDir });
      const service = yield* makeService({ agentDir, runner });

      const unconfirmed = yield* service
        .deleteResource({
          kind: "rules",
          name: "codegraph",
          scope: "global",
          confirm: false,
        })
        .pipe(Effect.flip);
      expect(unconfirmed._tag).toBe("OmpCapabilitiesError");
      expect(unconfirmed.reason).toContain("confirm");

      const missing = yield* service
        .deleteResource({
          kind: "rules",
          name: "nope",
          scope: "global",
          confirm: true,
        })
        .pipe(Effect.flip);
      expect(missing._tag).toBe("OmpCapabilitiesError");

      yield* service.deleteResource({
        kind: "rules",
        name: "codegraph",
        scope: "global",
        confirm: true,
      });
      expect(yield* fs.exists(path.join(agentDir, "rules", "codegraph.md"))).toBe(false);

      yield* service.deleteResource({
        kind: "skills",
        name: "create-ticket",
        scope: "global",
        confirm: true,
      });
      expect(yield* fs.exists(path.join(agentDir, "skills", "create-ticket"))).toBe(false);
    }),
  );

  it.effect("backs up project-scoped deletes before removing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const agentDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-agent-" });
      const projectCwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-omp-project-" });
      const rulesDir = path.join(projectCwd, ".omp", "rules");
      yield* fs.makeDirectory(rulesDir, { recursive: true });
      yield* fs.writeFileString(path.join(rulesDir, "codegraph.md"), "body");

      const { runner } = makeRunner({ agentDir });
      const service = yield* makeService({ agentDir, projectCwd, runner });

      yield* service.deleteResource({
        kind: "rules",
        name: "codegraph",
        scope: "project",
        projectId: ProjectId.make("project-1"),
        confirm: true,
      });
      expect(yield* fs.exists(path.join(rulesDir, "codegraph.md"))).toBe(false);
      const backups = yield* fs.readDirectory(rulesDir);
      expect(backups.some((name) => name.startsWith("codegraph.md.bak-"))).toBe(true);
    }),
  );
});
