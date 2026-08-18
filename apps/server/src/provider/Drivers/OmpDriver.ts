/**
 * OmpDriver — ProviderDriver for `omp --mode rpc`.
 *
 * create() owns one OmpRpcRuntime + OmpAdapter per instance and tears them
 * down when the registry scope closes. Model discovery (AC3) and slash-command
 * discovery probe `get_available_models` / `get_available_commands` through a
 * short-lived adapter session on refresh.
 * Binary resolution prefers a Pivot-managed GitHub install under
 * `{baseDir}/tools/omp/current`, then PATH / settings override.
 *
 * @module provider/Drivers/OmpDriver
 */
import * as NodeOS from "node:os";

import {
  OmpCapabilitiesError,
  OmpSettings,
  ProviderDriverKind,
  type ProjectId,
  type ServerProvider,
  type ServerProviderModel,
  ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ServerConfig from "../../config.ts";
import * as ProcessRunner from "../../processRunner.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeOmpTextGeneration } from "../../textGeneration/OmpTextGeneration.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  enrichOmpManagedBundleVersionAdvisory,
  makeOmpManagedBinary,
  OMP_MANAGED_UPDATE_EXECUTABLE,
  OMP_MANAGED_UPDATE_LOCK_KEY,
  OMP_NPM_PACKAGE_NAME,
  OmpAdapter,
  OmpCapabilitiesService,
  OmpConfigStore,
  OmpRpcRuntime,
  parseOmpModelRoleSlug,
  syncOmpSettingsToConfigStore,
} from "../omp/index.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import * as Option from "effect/Option";
import { buildServerProvider, type ServerProviderDraft } from "../providerSnapshot.ts";
import { hasPathSeparator, makeProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import type { ServerProviderShape } from "../Services/ServerProvider.ts";

const decodeOmpSettings = Schema.decodeSync(OmpSettings);
const DRIVER_KIND = ProviderDriverKind.make("omp");
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const OMP_PRESENTATION = {
  displayName: "omp",
  showInteractionModeToggle: true,
  requiresNewThreadForModelChange: false,
} as const;

export type OmpDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProcessRunner.ProcessRunner
  | ProjectionSnapshotQuery
  | ServerConfig.ServerConfig
  | ServerSettingsService;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

function makeOmpMaintenanceCapabilities() {
  const capabilities = makeProviderMaintenanceCapabilities({
    provider: DRIVER_KIND,
    packageName: OMP_NPM_PACKAGE_NAME,
    updateExecutable: OMP_MANAGED_UPDATE_EXECUTABLE,
    updateArgs: ["install"],
    updateLockKey: OMP_MANAGED_UPDATE_LOCK_KEY,
  });
  if (!capabilities.update) {
    return capabilities;
  }
  return {
    ...capabilities,
    update: {
      ...capabilities.update,
      command: "Pivot managed install (GitHub oh-my-pi)",
    },
  };
}

function makeOmpSnapshot(input: {
  readonly stampIdentity: (draft: ServerProviderDraft) => ServerProvider;
  readonly enabled: boolean;
  readonly adapter: OmpAdapter;
  readonly runtime: OmpRpcRuntime;
  readonly randomUUID: Effect.Effect<string>;
  readonly baseDir: string;
  readonly resolveBinary: Effect.Effect<{
    readonly installed: boolean;
    readonly binaryPath: string | null;
    readonly version: string | null;
    readonly source: "override" | "managed" | "path" | "missing" | "unsupported";
  }>;
}): Effect.Effect<
  ServerProviderShape,
  never,
  | Scope.Scope
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ServerSettingsService
> {
  return Effect.gen(function* () {
    const maintenanceCapabilities = makeOmpMaintenanceCapabilities();
    const serverSettings = yield* ServerSettingsService;
    const httpClient = yield* HttpClient.HttpClient;
    const crypto = yield* Crypto.Crypto;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const provideBundleServices = <A, E>(
      effect: Effect.Effect<
        A,
        E,
        | ChildProcessSpawner.ChildProcessSpawner
        | Crypto.Crypto
        | FileSystem.FileSystem
        | HttpClient.HttpClient
        | Path.Path
      >,
    ) =>
      effect.pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.provideService(Path.Path, path),
      );

    const buildSnapshot = (
      models: ReadonlyArray<ServerProviderModel>,
      probe: {
        readonly installed: boolean;
        readonly version: string | null;
        readonly status: "ready" | "warning" | "error";
        readonly message: string;
      },
      slashCommands: ReadonlyArray<ServerProvider["slashCommands"][number]> = [],
    ) =>
      Effect.gen(function* () {
        const checkedAt = yield* nowIso;
        return input.stampIdentity(
          buildServerProvider({
            presentation: OMP_PRESENTATION,
            enabled: input.enabled,
            checkedAt,
            models,
            slashCommands,
            probe: {
              installed: probe.installed,
              version: probe.version,
              status: probe.status,
              auth: { status: "unknown" },
              message: probe.message,
            },
          }),
        );
      });

    const initial = yield* buildSnapshot(
      [],
      {
        installed: false,
        version: null,
        status: "warning",
        message: input.enabled
          ? "Loading omp binary and models."
          : "omp is disabled in Pivot settings.",
      },
      [],
    );
    const latest = yield* Ref.make(initial);
    const changes = yield* PubSub.unbounded<ServerProvider>();
    yield* Effect.addFinalizer(() => PubSub.shutdown(changes));

    const publish = (snapshot: ServerProvider) =>
      Effect.gen(function* () {
        const enableProviderUpdateChecks = yield* serverSettings.getSettings.pipe(
          Effect.map((settings) => settings.enableProviderUpdateChecks),
          Effect.orElseSucceed(() => true),
        );
        const resolved = yield* input.resolveBinary;
        const enriched = yield* provideBundleServices(
          enrichOmpManagedBundleVersionAdvisory(snapshot, maintenanceCapabilities, {
            baseDir: input.baseDir,
            enableProviderUpdateChecks,
            checkManagedRtk:
              resolved.source === "managed" || resolved.source === "missing" || !resolved.installed,
          }),
        );
        yield* Ref.set(latest, enriched);
        yield* PubSub.publish(changes, enriched);
        return enriched;
      });

    const refresh = Effect.gen(function* () {
      if (!input.enabled) {
        return yield* publish(
          yield* buildSnapshot([], {
            installed: false,
            version: null,
            status: "warning",
            message: "omp is disabled in Pivot settings.",
          }),
        );
      }

      const resolved = yield* input.resolveBinary;
      if (!resolved.installed || !resolved.binaryPath) {
        const message =
          resolved.source === "unsupported"
            ? "Pivot cannot install a managed omp binary on this platform. Install omp manually and set Binary path."
            : "omp is not installed. Use Install in Settings to download a managed binary, or set Binary path.";
        return yield* publish(
          yield* buildSnapshot([], {
            installed: false,
            version: null,
            status: "warning",
            message,
          }),
        );
      }
      input.runtime.setBinaryPath(resolved.binaryPath);

      const probeId = yield* input.randomUUID;
      const threadId = ThreadId.make(`omp-model-probe-${probeId}`);
      yield* input.adapter.startSession({
        threadId,
        provider: DRIVER_KIND,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const discovered = yield* Effect.gen(function* () {
        const models = yield* input.adapter.discoverModels(threadId);
        const slashCommands = yield* input.adapter
          .discoverSlashCommands(threadId)
          .pipe(Effect.catch(() => Effect.succeed([])));
        return { models, slashCommands };
      }).pipe(Effect.ensuring(input.adapter.stopSession(threadId)));
      return yield* publish(
        yield* buildSnapshot(
          discovered.models,
          {
            installed: true,
            version: resolved.version,
            status: "ready",
            message: `omp models loaded from get_available_models (${resolved.source}).`,
          },
          discovered.slashCommands,
        ),
      );
    }).pipe(
      Effect.scoped,
      Effect.catchCause(() =>
        input.resolveBinary.pipe(
          Effect.flatMap((resolved) =>
            buildSnapshot([], {
              installed: resolved.installed,
              version: resolved.version,
              status: "error",
              message: resolved.installed
                ? "Failed to load omp models from get_available_models."
                : "omp is not installed or failed to start.",
            }),
          ),
          Effect.flatMap(publish),
        ),
      ),
    );

    yield* refresh.pipe(Effect.forkScoped);

    return {
      maintenanceCapabilities,
      getSnapshot: Ref.get(latest),
      refresh,
      streamChanges: Stream.fromPubSub(changes),
    } satisfies ServerProviderShape;
  });
}

export const OmpDriver: ProviderDriver<OmpSettings, OmpDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "omp",
    supportsMultipleInstances: true,
  },
  configSchema: OmpSettings,
  defaultConfig: (): OmpSettings => decodeOmpSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const serverConfig = yield* ServerConfig.ServerConfig;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = decodeOmpSettings({ ...config, enabled });
      const crypto = yield* Crypto.Crypto;
      const randomUUID = crypto.randomUUIDv4.pipe(Effect.orDie);

      const binaryPathSetting = effectiveConfig.binaryPath.trim();
      const managed = yield* makeOmpManagedBinary({
        baseDir: serverConfig.baseDir,
        binaryPathOverride: hasPathSeparator(binaryPathSetting) ? binaryPathSetting : undefined,
        pathEnv: process.env.PATH,
      });

      const resolveBinary = managed.resolve.pipe(
        Effect.map((status) => {
          if (status.status === "available") {
            return {
              installed: true,
              binaryPath: status.executablePath,
              version: status.version,
              source: status.source,
            };
          }
          if (status.status === "unsupported") {
            return {
              installed: false,
              binaryPath: null,
              version: null,
              source: "unsupported" as const,
            };
          }
          return {
            installed: false,
            binaryPath: null,
            version: null,
            source: "missing" as const,
          };
        }),
      );

      const initialResolved = yield* resolveBinary;
      const launchBinary =
        initialResolved.binaryPath ??
        (hasPathSeparator(binaryPathSetting) ? binaryPathSetting : binaryPathSetting || "omp");
      const pathService = yield* Path.Path;
      const rtkCurrentDir = pathService.join(serverConfig.baseDir, "tools", "rtk", "current");

      const runtime = new OmpRpcRuntime(spawner, launchBinary, {
        pathPrefixDirs: [rtkCurrentDir],
        environment,
      });
      const fs = yield* FileSystem.FileSystem;
      const ompHomeEnv = process.env.OMP_HOME?.trim();
      const ompHome =
        ompHomeEnv && ompHomeEnv.length > 0
          ? ompHomeEnv
          : pathService.join(NodeOS.homedir(), ".omp");
      // `omp config path` is AUTHORITATIVE for the active agent dir (honors
      // profiles, PI_CODING_AGENT_DIR, PI_CONFIG_DIR, XDG). The store state IS
      // the agent dir — config.yml sits at <agentDir>/config.yml. The driver
      // degrades to the legacy OMP_HOME/~/.omp derivation only when the CLI
      // cannot run (e.g. binary not yet installed); OmpCapabilitiesService
      // itself re-resolves per call and fails closed with a typed error.
      const processRunner = yield* ProcessRunner.ProcessRunner;
      const resolveAgentDir = Effect.gen(function* () {
        const result = yield* processRunner
          .run({ command: launchBinary, args: ["config", "path"] })
          .pipe(Effect.orDie);
        const stdout = result.stdout.trim();
        if (result.code !== 0 || result.timedOut || stdout.length === 0) {
          return yield* Effect.fail("omp config path failed");
        }
        return stdout;
      });
      const agentDir = yield* resolveAgentDir.pipe(
        Effect.orElseSucceed(() => pathService.join(ompHome, "agent")),
      );
      const ompConfigStore = new OmpConfigStore(fs, pathService, agentDir);
      // Settings updates recreate the instance via ProviderInstanceRegistryMutator,
      // so create() is the sync point for OmpSettings → omp config.yml.
      yield* syncOmpSettingsToConfigStore(effectiveConfig, ompConfigStore).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      const resolveRoleModel = (role: string) =>
        Effect.gen(function* () {
          const configPath = pathService.join(agentDir, "config.yml");
          const exists = yield* fs.exists(configPath);
          if (!exists) {
            return undefined;
          }
          const text = yield* fs.readFileString(configPath);
          return parseOmpModelRoleSlug(text, role);
        }).pipe(Effect.orElseSucceed(() => undefined));
      // Trusted project cwd from the orchestration read model — capabilities
      // inputs carry only a ProjectId, never a client-supplied path.
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const resolveProjectCwd = (projectId: ProjectId) =>
        Effect.gen(function* () {
          const project = yield* snapshotQuery.getProjectShellById(projectId).pipe(
            Effect.mapError(
              (cause) =>
                new OmpCapabilitiesError({
                  reason: "failed to resolve the project workspace for capabilities",
                  cause,
                }),
            ),
          );
          if (Option.isNone(project)) {
            return yield* new OmpCapabilitiesError({
              reason: `no active project bound to id '${projectId}'`,
            });
          }
          return project.value.workspaceRoot;
        });
      const listProjectWorkspaces = () =>
        snapshotQuery.getSnapshot().pipe(
          Effect.mapError(
            (cause) =>
              new OmpCapabilitiesError({
                reason: "failed to enumerate project workspaces for capabilities",
                cause,
              }),
          ),
          Effect.map((readModel) =>
            readModel.projects.map((project) => ({
              projectId: project.id,
              cwd: project.workspaceRoot,
              title: project.title,
            })),
          ),
        );
      const capabilitiesService = new OmpCapabilitiesService(
        fs,
        pathService,
        launchBinary,
        processRunner,
        ompConfigStore,
        resolveProjectCwd,
        listProjectWorkspaces,
      );
      const adapter = new OmpAdapter(runtime, randomUUID, {
        resolveRoleModel,
        capabilitiesService,
      });
      yield* Effect.addFinalizer(() => adapter.stopAll());

      // Keep runtime binaryPath aligned after managed install/refresh by
      // recreating is heavy; refresh uses the adapter already constructed with
      // the best-known path at create. Install path restarts the instance via
      // registry refresh after updateProvider.
      const snapshot = yield* makeOmpSnapshot({
        stampIdentity,
        enabled: effectiveConfig.enabled,
        adapter,
        runtime,
        randomUUID,
        baseDir: serverConfig.baseDir,
        resolveBinary,
      });
      // Text generation re-resolves the managed binary per call so Install works
      // without rematerializing the whole provider instance.
      const textGeneration = yield* makeOmpTextGeneration({
        ...effectiveConfig,
        binaryPath: launchBinary,
        resolveBinaryPath: resolveBinary.pipe(
          Effect.map((resolved) => resolved.binaryPath ?? launchBinary),
        ),
        environment,
      });

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
