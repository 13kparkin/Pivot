/**
 * OmpDriver — ProviderDriver for `omp --mode rpc`.
 *
 * create() owns one OmpRpcRuntime + OmpAdapter per instance and tears them
 * down when the registry scope closes.
 *
 * @module provider/Drivers/OmpDriver
 */
import {
  OmpSettings,
  ProviderDriverKind,
  TextGenerationError,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import { OmpAdapter } from "../omp/OmpAdapter.ts";
import { OmpRpcRuntime } from "../omp/OmpRpcRuntime.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { buildServerProvider, type ServerProviderDraft } from "../providerSnapshot.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import type { ServerProviderShape } from "../Services/ServerProvider.ts";

const decodeOmpSettings = Schema.decodeSync(OmpSettings);
const DRIVER_KIND = ProviderDriverKind.make("omp");
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const OMP_PRESENTATION = {
  displayName: "omp",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: false,
} as const;

export type OmpDriverEnv = ChildProcessSpawner.ChildProcessSpawner;

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

function makeUnsupportedTextGeneration(): TextGeneration.TextGeneration["Service"] {
  const fail = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: "unsupported: omp text generation is not wired yet",
      }),
    );
  return TextGeneration.TextGeneration.of({
    generateCommitMessage: () => fail("generateCommitMessage"),
    generatePrContent: () => fail("generatePrContent"),
    generateBranchName: () => fail("generateBranchName"),
    generateThreadTitle: () => fail("generateThreadTitle"),
  });
}

function makeStaticSnapshot(input: {
  readonly stampIdentity: (draft: ServerProviderDraft) => ServerProvider;
  readonly enabled: boolean;
}): Effect.Effect<ServerProviderShape> {
  return Effect.gen(function* () {
    const checkedAt = yield* nowIso;
    const draft = buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: input.enabled,
      checkedAt,
      models: [],
      probe: {
        installed: input.enabled,
        version: null,
        status: input.enabled ? "ready" : "warning",
        auth: { status: "unknown" },
        message: input.enabled
          ? "omp models load from get_available_models at session time."
          : "omp is disabled in T3 Code settings.",
      },
    });
    const snapshot = input.stampIdentity(draft);
    const maintenanceCapabilities = makeManualOnlyProviderMaintenanceCapabilities({
      provider: DRIVER_KIND,
      packageName: null,
    });
    return {
      maintenanceCapabilities,
      getSnapshot: Effect.succeed(snapshot),
      refresh: Effect.succeed(snapshot),
      streamChanges: Stream.empty,
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
  create: ({ instanceId, displayName, accentColor, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
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
      const effectiveConfig = { ...config, enabled } satisfies OmpSettings;
      const runtime = new OmpRpcRuntime(spawner, effectiveConfig.binaryPath);
      const adapter = new OmpAdapter(runtime);
      yield* Effect.addFinalizer(() => adapter.stopAll());

      const snapshot = yield* makeStaticSnapshot({
        stampIdentity,
        enabled: effectiveConfig.enabled,
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
        textGeneration: makeUnsupportedTextGeneration(),
      } satisfies ProviderInstance;
    }),
};
