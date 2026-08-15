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
  OmpCapabilityEditableKind,
  OmpCapabilityItem,
  OmpCapabilityItemScope,
  OmpCapabilityKind,
  type OmpCapabilityResource,
  type OmpCapabilityScope,
  OmpDeleteResourceInput,
  OmpReadResourceInput,
  OmpReadResourceResult,
  type OmpResetSettingInput,
  type OmpSettingsSurfaceEntry,
  OmpWriteResourceInput,
  type OmpWriteSettingInput,
  type ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { parse as parseYaml } from "yaml";
import type * as ProcessRunner from "../../processRunner.ts";
import { writeFileStringAtomically } from "../../atomicWrite.ts";
import { OmpConfigStore } from "./OmpConfigStore.ts";

const MASKED_VALUE = "********";

/**
 * Schema-based JSON encoder (the repo lint forbids bare JSON.stringify).
 * Used to serialize structured setting values for `omp config set`, whose
 * CLI parses records/arrays back out of JSON.
 */
const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

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

/**
 * Parse a raw config editor value into a YAML scalar so project-layer
 * writes store `autoResume: false` (boolean) instead of `'false'` (string).
 * Mirrors how `omp config set` treats scalar input; anything unrecognized
 * stays a string.
 */
function parseConfigScalar(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (value.trim() !== "" && !Number.isNaN(Number(value))) return Number(value);
  return value;
}

/**
 * Flatten a config doc's scalar leaves into dotted keys (`modelRoles.default`)
 * so the displayed key matches the write key the server accepts.
 */
function flattenScalarConfig(
  doc: Record<string, unknown>,
  prefix = "",
): ReadonlyArray<[string, string | number | boolean]> {
  const out: Array<[string, string | number | boolean]> = [];
  for (const [key, value] of Object.entries(doc)) {
    const dotted = prefix === "" ? key : `${prefix}.${key}`;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out.push([dotted, value]);
    } else if (isRecord(value)) {
      out.push(...flattenScalarConfig(value, dotted));
    }
  }
  return out;
}

const isSecretSetting = (key: string, type: string): boolean =>
  type === "secret" || SECRET_KEY_PATTERN.test(key);

function parseFrontmatterDescription(content: string): string | undefined {
  if (!content.startsWith("---")) return undefined;
  const end = content.indexOf("\n---");
  if (end < 0) return undefined;
  const block = content.slice(3, end);
  const match = block.match(/^\s*description:\s*(.+)$/m);
  if (match === null) return undefined;
  const value = (match[1] ?? "").trim().replace(/^["']|["']$/g, "");
  return value.length > 0 ? value : undefined;
}

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
      const settings = yield* this.readSettingsSurface(projectCwd);
      const resources = yield* this.inventory(agentDir, projectCwd);
      const items = yield* this.inventoryItems(agentDir, projectCwd);
      const agentDirLabel = this.tildeLabel(agentDir);
      return {
        ...(agentDirLabel !== undefined ? { agentDirLabel } : {}),
        settings,
        resources,
        skills: items.skills,
        rules: items.rules,
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
        // `omp config set` parses values schema-driven (booleans, numbers,
        // JSON arrays/records) from a single string argument. String()
        // alone would serialize records/arrays as "[object Object]" and
        // corrupt the config, so only primitives pass through verbatim.
        const serialized =
          typeof input.value === "string" ? input.value : encodeUnknownJson(input.value);
        yield* this.runOmpConfig(["set", input.key, serialized]);
      } else {
        const projectCwd = yield* this.resolveProjectScopeCwd(input.projectId);
        yield* this.backup(projectCwd);
        yield* this.#configStore.writeProjectKey(
          projectCwd,
          input.key,
          typeof input.value === "string" ? parseConfigScalar(input.value) : input.value,
        );
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

  /**
   * Read one rule/skill item. `exists: false` (empty content) when the item
   * does not exist — the editor uses this to distinguish create from edit.
   */
  public readResource(
    input: OmpReadResourceInput,
  ): Effect.Effect<OmpReadResourceResult, OmpCapabilitiesError> {
    return Effect.gen({ self: this }, function* () {
      const scopeDir = yield* this.resolveItemScopeDir(input.scope, input.projectId);
      const { itemFile } = this.resolveItemPaths(input.kind, scopeDir, input.name);
      const exists = yield* this.existsPath(itemFile);
      if (!exists) {
        return { name: input.name, scope: input.scope, content: "", exists: false };
      }
      const content = yield* this.readItemFile(itemFile);
      return { name: input.name, scope: input.scope, content, exists: true };
    });
  }

  /**
   * Create or replace a rule/skill item. Existing items require
   * `overwrite: true`; project-scoped overwrites back up the target file
   * first (D7). Returns the refreshed snapshot.
   */
  public writeResource(
    input: OmpWriteResourceInput,
  ): Effect.Effect<OmpCapabilitiesSnapshot, OmpCapabilitiesError> {
    return Effect.gen({ self: this }, function* () {
      const scopeDir = yield* this.resolveItemScopeDir(input.scope, input.projectId);
      const { itemFile } = this.resolveItemPaths(input.kind, scopeDir, input.name);
      const exists = yield* this.existsPath(itemFile);
      if (exists && input.overwrite !== true) {
        return yield* new OmpCapabilitiesError({
          reason: `${input.kind} item ${input.name} already exists; pass overwrite: true to replace it`,
        });
      }
      if (input.scope === "project" && exists) {
        yield* this.backupFile(itemFile);
      }
      yield* this.writeItemFile(itemFile, input.content);
      return yield* this.getSnapshot(input.projectId);
    });
  }

  /**
   * Destructive rule/skill delete, confirm-gated (D7). Rules delete their
   * file; skills delete the whole item directory. Project-scoped deletes back
   * up the target file first. Returns the refreshed snapshot.
   */
  public deleteResource(
    input: OmpDeleteResourceInput,
  ): Effect.Effect<OmpCapabilitiesSnapshot, OmpCapabilitiesError> {
    return Effect.gen({ self: this }, function* () {
      if (input.confirm !== true) {
        return yield* new OmpCapabilitiesError({
          reason: "deleting a resource is destructive and requires confirm: true",
        });
      }
      const scopeDir = yield* this.resolveItemScopeDir(input.scope, input.projectId);
      const { itemDir, itemFile } = this.resolveItemPaths(input.kind, scopeDir, input.name);
      const exists = yield* this.existsPath(itemFile);
      if (!exists) {
        return yield* new OmpCapabilitiesError({
          reason: `no ${input.kind} item named ${input.name}`,
        });
      }
      if (input.scope === "project") {
        yield* this.backupFile(itemFile);
      }
      if (input.kind === "skills") {
        yield* this.removeItemDir(itemDir);
      } else {
        yield* this.removeItemFile(itemFile);
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

  private readSettingsSurface(
    projectCwd?: string,
  ): Effect.Effect<
    { readonly entries: ReadonlyArray<OmpSettingsSurfaceEntry> },
    OmpCapabilitiesError
  > {
    return projectCwd === undefined
      ? this.readEffectiveSettingsSurface()
      : this.readProjectSettingsSurface(projectCwd);
  }

  /** Effective merged settings from `omp config list --json`, tagged global. */
  private readEffectiveSettingsSurface(): Effect.Effect<
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
      const enumValues = yield* this.readEnumValues();
      const entries: OmpSettingsSurfaceEntry[] = [];
      for (const [key, info] of Object.entries(raw)) {
        if (!isRecord(info) || typeof info.type !== "string") {
          continue;
        }
        const masked = isSecretSetting(key, info.type);
        const values = info.type === "enum" ? enumValues.get(key) : undefined;
        entries.push({
          key,
          ...(info.value !== undefined ? { value: info.value } : {}),
          ...(masked ? { value: MASKED_VALUE } : {}),
          ...(values !== undefined ? { values } : {}),
          type: info.type,
          description: typeof info.description === "string" ? info.description : "",
          masked,
          scope: "global",
        } satisfies OmpSettingsSurfaceEntry);
      }
      return { entries };
    });
  }

  /**
   * Enum choices come from the human `omp config list` type column, which
   * prints them as `(off|idle|display|system)`; `--json` omits them. Any
   * failure degrades to an empty map so an older binary only loses the
   * dropdowns, never the settings surface.
   */
  private readEnumValues(): Effect.Effect<ReadonlyMap<string, readonly string[]>> {
    return this.runOmpConfig(["list"]).pipe(
      Effect.map((result) => {
        const valuesByKey = new Map<string, readonly string[]>();
        for (const line of result.stdout.split("\n")) {
          const match = /^ {2}([^ =]+) = .* \(([^()]*)\)$/.exec(line);
          if (match === null) continue;
          const values = match[2]!
            .split("|")
            .map((value) => value.trim())
            .filter((value) => value.length > 0);
          if (values.length > 0) valuesByKey.set(match[1]!, values);
        }
        return valuesByKey;
      }),
      Effect.catch(() =>
        Effect.succeed(
          new Map<string, readonly string[]>() as ReadonlyMap<string, readonly string[]>,
        ),
      ),
    );
   * The project layer of omp settings, read directly from the project's
   * `.omp/config.yml`. `omp config list --json` only reports the EFFECTIVE
   * merged config, so the project-scoped surface reads the file itself to
   * show exactly what this project overrides. Scalar leaves flatten to dot
   * keys so the displayed key matches the write key (writeProjectKey).
   */
  private readProjectSettingsSurface(
    projectCwd: string,
  ): Effect.Effect<
    { readonly entries: ReadonlyArray<OmpSettingsSurfaceEntry> },
    OmpCapabilitiesError
  > {
    return Effect.gen({ self: this }, function* () {
      const configPath = this.#path.join(projectCwd, ".omp", "config.yml");
      const exists = yield* this.#fileSystem.exists(configPath);
      if (!exists) return { entries: [] };
      const text = yield* this.#fileSystem.readFileString(configPath);
      let doc: unknown;
      try {
        doc = parseYaml(text);
      } catch {
        return { entries: [] };
      }
      if (!isRecord(doc)) return { entries: [] };
      const entries: OmpSettingsSurfaceEntry[] = [];
      for (const [key, value] of flattenScalarConfig(doc)) {
        const type =
          typeof value === "boolean" ? "boolean" : typeof value === "number" ? "number" : "string";
        entries.push({
          key,
          value,
          type,
          description: "",
          masked: isSecretSetting(key, type),
          scope: "project",
        });
      }
      return { entries };
    }).pipe(
      Effect.mapError(
        (cause) =>
          new OmpCapabilitiesError({
            reason: "failed to read the project settings layer",
            cause,
          }),
      ),
    );
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

  /**
   * Item-level inventory of rules and skills across the global agent dir and
   * (when resolved) the project `.omp` folder. Non-markdown files, the rules
   * `support/` bundle, and skill dirs without a `SKILL.md` are not items.
   */
  private inventoryItems(
    agentDir: string,
    projectCwd: string | undefined,
  ): Effect.Effect<
    {
      readonly skills: ReadonlyArray<OmpCapabilityItem>;
      readonly rules: ReadonlyArray<OmpCapabilityItem>;
    },
    OmpCapabilitiesError
  > {
    return Effect.gen({ self: this }, function* () {
      const scopes: ReadonlyArray<{
        readonly scope: OmpCapabilityItemScope;
        readonly dir: string;
      }> = [
        { scope: "global", dir: agentDir },
        ...(projectCwd !== undefined
          ? [{ scope: "project" as const, dir: this.#path.join(projectCwd, ".omp") }]
          : []),
      ];
      const skills: OmpCapabilityItem[] = [];
      const rules: OmpCapabilityItem[] = [];
      for (const scope of scopes) {
        skills.push(...(yield* this.listItemKind("skills", scope.dir, scope.scope)));
        rules.push(...(yield* this.listItemKind("rules", scope.dir, scope.scope)));
      }
      return { skills, rules };
    }).pipe(
      Effect.mapError(
        (cause) =>
          new OmpCapabilitiesError({
            reason: "failed to inventory omp rule and skill items",
            cause,
          }),
      ),
    );
  }

  private listItemKind(
    kind: OmpCapabilityEditableKind,
    scopeDir: string,
    scope: OmpCapabilityItemScope,
  ): Effect.Effect<ReadonlyArray<OmpCapabilityItem>, OmpCapabilitiesError> {
    return Effect.gen({ self: this }, function* () {
      const kindDir = this.#path.join(scopeDir, kind);
      const dirExists = yield* this.existsPath(kindDir);
      if (!dirExists) return [];
      const entries = yield* this.#fileSystem.readDirectory(kindDir);
      const items: OmpCapabilityItem[] = [];
      for (const entry of entries) {
        const item = yield* this.itemFromEntry(kind, kindDir, scope, entry);
        if (item !== undefined) items.push(item);
      }
      return items.sort((a, b) => a.name.localeCompare(b.name));
    }).pipe(
      Effect.mapError(
        (cause) =>
          new OmpCapabilitiesError({
            reason: `failed to inventory ${kind} items`,
            cause,
          }),
      ),
    );
  }

  private itemFromEntry(
    kind: OmpCapabilityEditableKind,
    kindDir: string,
    scope: OmpCapabilityItemScope,
    entry: string,
  ): Effect.Effect<OmpCapabilityItem | undefined, OmpCapabilitiesError> {
    return Effect.gen({ self: this }, function* () {
      if (kind === "rules") {
        if (!entry.endsWith(".md")) return undefined;
        const name = entry.slice(0, -".md".length);
        if (name.length === 0) return undefined;
        const description = yield* this.frontmatterDescription(this.#path.join(kindDir, entry));
        return { name, scope, ...(description !== undefined ? { description } : {}) };
      }
      const skillFile = this.#path.join(kindDir, entry, "SKILL.md");
      const exists = yield* this.existsPath(skillFile);
      if (!exists) return undefined;
      const description = yield* this.frontmatterDescription(skillFile);
      return { name: entry, scope, ...(description !== undefined ? { description } : {}) };
    });
  }

  /** Frontmatter `description` for list display; unreadable files degrade to no description. */
  private frontmatterDescription(
    filePath: string,
  ): Effect.Effect<string | undefined, OmpCapabilitiesError> {
    return Effect.gen({ self: this }, function* () {
      const contents = yield* this.readItemFile(filePath).pipe(Effect.option);
      const raw = Option.getOrUndefined(contents);
      return raw === undefined ? undefined : parseFrontmatterDescription(raw);
    });
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
    return this.backupFile(this.#path.join(projectCwd, ".omp", "config.yml"));
  }

  /** Timestamped `.bak` copy of a file before a project-scoped mutate (D7). */
  private backupFile(filePath: string): Effect.Effect<void, OmpCapabilitiesError> {
    return Effect.gen({ self: this }, function* () {
      const fs = this.#fileSystem;
      const exists = yield* fs.exists(filePath);
      if (!exists) return;
      const contents = yield* fs.readFileString(filePath);
      const timestamp = Math.floor(DateTime.toEpochMillis(yield* DateTime.now) / 1000);
      yield* writeFileStringAtomically({
        filePath: `${filePath}.bak-${timestamp}`,
        contents,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, this.#path),
      );
    }).pipe(
      Effect.mapError(
        (cause) =>
          new OmpCapabilitiesError({
            reason: "failed to back up the file before writing",
            cause,
          }),
      ),
    );
  }

  /** Scope root for item reads/writes: agent dir (global) or `<cwd>/.omp` (project). */
  private resolveItemScopeDir(
    scope: OmpCapabilityItemScope,
    projectId: ProjectId | undefined,
  ): Effect.Effect<string, OmpCapabilitiesError> {
    return Effect.gen({ self: this }, function* () {
      if (scope === "project") {
        const projectCwd = yield* this.resolveProjectScopeCwd(projectId);
        return this.#path.join(projectCwd, ".omp");
      }
      return yield* this.resolveAgentDir();
    });
  }

  /**
   * On-disk layout for an item: rules are single `<name>.md` files; skills
   * are `<name>/SKILL.md` directories.
   */
  private resolveItemPaths(
    kind: OmpCapabilityEditableKind,
    scopeDir: string,
    name: string,
  ): { readonly itemDir: string; readonly itemFile: string } {
    if (kind === "rules") {
      const itemFile = this.#path.join(scopeDir, "rules", `${name}.md`);
      return { itemDir: this.#path.dirname(itemFile), itemFile };
    }
    const itemDir = this.#path.join(scopeDir, "skills", name);
    return { itemDir, itemFile: this.#path.join(itemDir, "SKILL.md") };
  }

  private existsPath(filePath: string): Effect.Effect<boolean, OmpCapabilitiesError> {
    return this.#fileSystem.exists(filePath).pipe(
      Effect.mapError(
        (cause) =>
          new OmpCapabilitiesError({
            reason: "failed to check capability item file",
            cause,
          }),
      ),
    );
  }

  private readItemFile(filePath: string): Effect.Effect<string, OmpCapabilitiesError> {
    return this.#fileSystem.readFileString(filePath).pipe(
      Effect.mapError(
        (cause) =>
          new OmpCapabilitiesError({
            reason: `failed to read capability item file`,
            cause,
          }),
      ),
    );
  }

  private writeItemFile(
    filePath: string,
    contents: string,
  ): Effect.Effect<void, OmpCapabilitiesError> {
    return writeFileStringAtomically({ filePath, contents }).pipe(
      Effect.provideService(FileSystem.FileSystem, this.#fileSystem),
      Effect.provideService(Path.Path, this.#path),
      Effect.mapError(
        (cause) =>
          new OmpCapabilitiesError({
            reason: "failed to write capability item file",
            cause,
          }),
      ),
    );
  }

  private removeItemFile(filePath: string): Effect.Effect<void, OmpCapabilitiesError> {
    return this.#fileSystem.remove(filePath, { force: true }).pipe(
      Effect.mapError(
        (cause) =>
          new OmpCapabilitiesError({
            reason: "failed to delete capability item file",
            cause,
          }),
      ),
    );
  }

  private removeItemDir(dirPath: string): Effect.Effect<void, OmpCapabilitiesError> {
    return this.#fileSystem.remove(dirPath, { recursive: true, force: true }).pipe(
      Effect.mapError(
        (cause) =>
          new OmpCapabilitiesError({
            reason: "failed to delete capability item directory",
            cause,
          }),
      ),
    );
  }
}
