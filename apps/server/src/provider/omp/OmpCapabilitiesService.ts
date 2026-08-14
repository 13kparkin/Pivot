/**
 * OmpCapabilitiesService — server-owned read/write surface for OMP config.
 *
 * Resolves the active agent dir authoritatively via `omp config path`
 * (honors profiles, `PI_CODING_AGENT_DIR`, `PI_CONFIG_DIR`, XDG) and FAILS
 * CLOSED on CLI failure — no `OMP_HOME`/`~/.omp` fallback for I/O paths (D3).
 * Project scope resolves the trusted cwd from a `ProjectId` through an
 * injected read-model resolver; clients never supply paths (D3, D5).
 *
 * Secrets (`models.yml` keys, `.env`, token settings) are masked or reduced
 * to `hasValue` metadata — never returned over the wire (D6). Every write is
 * scoped and validated; project writes take a timestamped `.bak` before
 * mutating and destructive resets require `confirm: true` (D7).
 *
 * @module provider/omp/OmpCapabilitiesService
 */
import * as NodeOS from "node:os";

import {
  OmpCapabilitiesError,
  OmpCapabilitiesSnapshot,
  OmpCapabilityKind,
  type OmpCapabilityResource,
  type OmpCapabilityScope,
  type OmpResetSettingInput,
  type OmpSettingsSurfaceEntry,
  type OmpWriteSettingInput,
  type ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type * as ProcessRunner from "../../processRunner.ts";
import { writeFileStringAtomically } from "../../atomicWrite.ts";
import { OmpConfigStore } from "./OmpConfigStore.ts";

const MASKED_VALUE = "********";

/** Setting keys whose values are credentials → masked on the surface (D6). */
const SECRET_KEY_PATTERN = /(token|secret|password|api)/i;

/** Kinds backed by a single file at the scope root. */
const FILE_KINDS = [
  ["config", "config.yml"],
  ["models", "models.yml"],
  ["mcp", "mcp.json"],
  ["env", ".env"],
] as const satisfies ReadonlyArray<readonly [OmpCapabilityKind, string]>;

/** Kinds backed by a directory of capability files at the scope root. */
const DIR_KINDS = [
  "skills",
  "commands",
  "rules",
  "prompts",
  "instructions",
  "hooks",
  "tools",
  "extensions",
] as const satisfies ReadonlyArray<OmpCapabilityKind>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isSecretSetting = (key: string, type: string): boolean =>
  type === "secret" || SECRET_KEY_PATTERN.test(key);

export class OmpCapabilitiesService {
  readonly #fileSystem: FileSystem.FileSystem;
  readonly #path: Path.Path;
  /** Same binary the driver resolved (`omp config path` authority must match). */
  readonly #binaryPath: string;
  readonly #commandRunner: ProcessRunner.ProcessRunner["Service"];
  /** Agent-dir-scoped store; each call rebinds via `forAgentDir`. */
  readonly #configStore: OmpConfigStore;
  /** Trusted project cwd from the orchestration read model — never a client path. */
  readonly #resolveProjectCwd: (
    projectId: ProjectId,
  ) => Effect.Effect<string, OmpCapabilitiesError>;

  public constructor(
    fileSystem: FileSystem.FileSystem,
    path: Path.Path,
    binaryPath: string,
    commandRunner: ProcessRunner.ProcessRunner["Service"],
    configStore: OmpConfigStore,
    resolveProjectCwd: (projectId: ProjectId) => Effect.Effect<string, OmpCapabilitiesError>,
  ) {
    this.#fileSystem = fileSystem;
    this.#path = path;
    this.#binaryPath = binaryPath;
    this.#commandRunner = commandRunner;
    this.#configStore = configStore;
    this.#resolveProjectCwd = resolveProjectCwd;
  }

  public getSnapshot(
    projectId?: ProjectId,
  ): Effect.Effect<OmpCapabilitiesSnapshot, OmpCapabilitiesError> {
    return Effect.gen({ self: this }, function* () {
      const agentDir = yield* this.resolveAgentDir();
      const projectCwd =
        projectId === undefined ? undefined : yield* this.#resolveProjectCwd(projectId);
      const settings = yield* this.readSettingsSurface();
      const resources = yield* this.inventory(agentDir, projectCwd);
      const agentDirLabel = this.tildeLabel(agentDir);
      return {
        ...(agentDirLabel !== undefined ? { agentDirLabel } : {}),
        settings,
        resources,
      } satisfies OmpCapabilitiesSnapshot;
    });
  }

  public writeSetting(
    input: OmpWriteSettingInput,
  ): Effect.Effect<OmpCapabilitiesSnapshot, OmpCapabilitiesError> {
    return Effect.gen({ self: this }, function* () {
      if (input.scope === "profile") {
        return yield* new OmpCapabilitiesError({
          reason:
            "profile-scoped writes are not supported; edit the active profile's files directly",
        });
      }
      if (input.value === undefined) {
        return yield* new OmpCapabilitiesError({
          reason: "writeSetting requires a value; use resetSetting to remove a key",
        });
      }
      if (input.scope === "global") {
        yield* this.runOmpConfig(["set", input.key, String(input.value)]);
      } else {
        const projectCwd = yield* this.resolveProjectScopeCwd(input.projectId);
        yield* this.backup(projectCwd);
        yield* this.#configStore.writeProjectKey(projectCwd, input.key, input.value);
      }
      return yield* this.getSnapshot(input.projectId);
    });
  }

  public resetSetting(
    input: OmpResetSettingInput,
  ): Effect.Effect<OmpCapabilitiesSnapshot, OmpCapabilitiesError> {
    return Effect.gen({ self: this }, function* () {
      if (input.confirm !== true) {
        return yield* new OmpCapabilitiesError({
          reason: "resetting a setting is destructive and requires confirm: true",
        });
      }
      if (input.scope === "profile") {
        return yield* new OmpCapabilitiesError({
          reason:
            "profile-scoped writes are not supported; edit the active profile's files directly",
        });
      }
      if (input.scope === "global") {
        yield* this.runOmpConfig(["reset", input.key]);
      } else {
        const projectCwd = yield* this.resolveProjectScopeCwd(input.projectId);
        yield* this.backup(projectCwd);
        yield* this.#configStore.writeProjectKey(projectCwd, input.key, undefined);
      }
      return yield* this.getSnapshot(input.projectId);
    });
  }

  private resolveProjectScopeCwd(
    projectId: ProjectId | undefined,
  ): Effect.Effect<string, OmpCapabilitiesError> {
    if (projectId === undefined) {
      return new OmpCapabilitiesError({
        reason: "project-scoped writes require a projectId (the server resolves the trusted cwd)",
      });
    }
    return this.#resolveProjectCwd(projectId);
  }

  /** `omp config path` stdout is the active agent dir — authoritative, fail closed. */
  private resolveAgentDir(): Effect.Effect<string, OmpCapabilitiesError> {
    return Effect.gen({ self: this }, function* () {
      const result = yield* this.runOmpConfig(["path"]);
      const agentDir = result.stdout.trim();
      if (agentDir.length === 0) {
        return yield* new OmpCapabilitiesError({
          reason: "omp config path returned an empty agent directory",
        });
      }
      return agentDir;
    });
  }

  private readSettingsSurface(): Effect.Effect<
    { readonly entries: ReadonlyArray<OmpSettingsSurfaceEntry> },
    OmpCapabilitiesError
  > {
    return Effect.gen({ self: this }, function* () {
      const result = yield* this.runOmpConfig(["list", "--json"]);
      const decodeListJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
      const decoded = yield* decodeListJson(result.stdout).pipe(
        Effect.mapError(
          (cause) =>
            new OmpCapabilitiesError({
              reason: "omp config list --json returned invalid JSON",
              cause,
            }),
        ),
      );
      const raw = decoded;
      if (!isRecord(raw)) {
        return yield* new OmpCapabilitiesError({
          reason: "omp config list --json returned an unexpected shape",
        });
      }
      const entries: OmpSettingsSurfaceEntry[] = [];
      for (const [key, info] of Object.entries(raw)) {
        if (!isRecord(info) || typeof info.type !== "string") {
          continue;
        }
        const masked = isSecretSetting(key, info.type);
        entries.push({
          key,
          ...(info.value !== undefined ? { value: info.value } : {}),
          ...(masked ? { value: MASKED_VALUE } : {}),
          type: info.type,
          description: typeof info.description === "string" ? info.description : "",
          masked,
          scope: "global",
        } satisfies OmpSettingsSurfaceEntry);
      }
      return { entries };
    });
  }

  private inventory(
    agentDir: string,
    projectCwd: string | undefined,
  ): Effect.Effect<ReadonlyArray<OmpCapabilityResource>, OmpCapabilitiesError> {
    return Effect.gen({ self: this }, function* () {
      const resources: OmpCapabilityResource[] = [];
      const scopes: ReadonlyArray<{
        readonly scope: OmpCapabilityScope;
        readonly dir: string;
      }> = [
        { scope: "global", dir: agentDir },
        ...(projectCwd !== undefined ? [{ scope: "project" as const, dir: projectCwd }] : []),
      ];
      for (const scope of scopes) {
        // Agent-dir resources sit directly inside the agent dir; project
        // resources live under the project's `.omp` folder.
        const scopeDir = scope.scope === "project" ? this.#path.join(scope.dir, ".omp") : scope.dir;
        for (const [kind, fileName] of FILE_KINDS) {
          const filePath = this.#path.join(scopeDir, fileName);
          const exists = yield* this.#fileSystem.exists(filePath);
          resources.push({
            kind,
            name: fileName,
            scope: scope.scope,
            provenance: this.resolveProvenance(agentDir, scope.scope),
            exists,
            ...(kind === "env" ? { hasValue: exists } : {}),
            ...(kind === "models" && exists ? { masked: true } : {}),
          } satisfies OmpCapabilityResource);
        }
        for (const kind of DIR_KINDS) {
          const dirPath = this.#path.join(scopeDir, kind);
          const exists = yield* this.#fileSystem.exists(dirPath);
          resources.push({
            kind,
            name: kind,
            scope: scope.scope,
            provenance: this.resolveProvenance(agentDir, scope.scope),
            exists,
          } satisfies OmpCapabilityResource);
        }
      }
      return resources;
    }).pipe(
      Effect.mapError(
        (cause) =>
          new OmpCapabilitiesError({
            reason: "failed to inventory omp capability resources",
            cause,
          }),
      ),
    );
  }

  /** Provenance: profile when the active agent dir lives under a profiles tree. */
  private resolveProvenance(agentDir: string, scope: OmpCapabilityScope): OmpCapabilityScope {
    if (scope === "project") return "project";
    return agentDir.includes(`${this.#path.sep}profiles${this.#path.sep}`) ? "profile" : "global";
  }

  /** Display-only `~`-relative label; never an absolute host path on the wire. */
  private tildeLabel(agentDir: string): string | undefined {
    const home = NodeOS.homedir();
    if (agentDir === home) return "~";
    if (agentDir.startsWith(home + this.#path.sep)) {
      return `~${agentDir.slice(home.length)}`;
    }
    return undefined;
  }

  private runOmpConfig(
    args: ReadonlyArray<string>,
  ): Effect.Effect<ProcessRunner.ProcessRunOutput, OmpCapabilitiesError> {
    return Effect.gen({ self: this }, function* () {
      const result = yield* this.#commandRunner
        .run({ command: this.#binaryPath, args: ["config", ...args] })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OmpCapabilitiesError({
                reason: `omp config ${args.join(" ")} failed`,
                cause,
              }),
          ),
        );
      if (result.code !== 0 || result.timedOut) {
        const detail = (result.stderr || result.stdout || "").trim();
        return yield* new OmpCapabilitiesError({
          reason: detail.length > 0 ? detail : `omp config ${args.join(" ")} failed`,
        });
      }
      return result;
    });
  }

  /** Timestamped `.bak` copy of `<projectCwd>/.omp/config.yml` before a mutate (D7). */
  private backup(projectCwd: string): Effect.Effect<void, OmpCapabilitiesError> {
    return Effect.gen({ self: this }, function* () {
      const fs = this.#fileSystem;
      const configPath = this.#path.join(projectCwd, ".omp", "config.yml");
      const exists = yield* fs.exists(configPath);
      if (!exists) return;
      const contents = yield* fs.readFileString(configPath);
      const timestamp = Math.floor(DateTime.toEpochMillis(yield* DateTime.now) / 1000);
      yield* writeFileStringAtomically({
        filePath: `${configPath}.bak-${timestamp}`,
        contents,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, this.#path),
      );
    }).pipe(
      Effect.mapError(
        (cause) =>
          new OmpCapabilitiesError({
            reason: "failed to back up the project config before writing",
            cause,
          }),
      ),
    );
  }
}
