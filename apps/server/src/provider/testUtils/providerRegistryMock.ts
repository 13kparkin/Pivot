import { ProviderRegistry, type ProviderRegistryShape } from "../Services/ProviderRegistry.ts";
import type { ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";

export const makeProviderRegistryMock = (
  providers: ReadonlyArray<ServerProvider> = [],
): ProviderRegistryShape => ({
  getProviders: Effect.succeed(providers),
  refresh: () => Effect.succeed(providers),
  refreshInstance: () => Effect.succeed(providers),
  getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
    Effect.succeed(makeManualOnlyProviderMaintenanceCapabilities({ provider, packageName: null })),
  setProviderMaintenanceActionState: () => Effect.succeed(providers),
  listOmpLoginProviders: () => Effect.succeed([]),
  ompLogin: ({ providerId }) => Effect.succeed({ providerId }),
  ompCapabilitiesGetSnapshot: () =>
    Effect.succeed({ settings: { entries: [] }, resources: [], skills: [], rules: [] }),
  ompCapabilitiesWriteSetting: () =>
    Effect.succeed({ settings: { entries: [] }, resources: [], skills: [], rules: [] }),
  ompCapabilitiesResetSetting: () =>
    Effect.succeed({ settings: { entries: [] }, resources: [], skills: [], rules: [] }),
  ompCapabilitiesReadResource: () =>
    Effect.succeed({ name: "x", scope: "global", content: "", exists: false }),
  ompCapabilitiesWriteResource: () =>
    Effect.succeed({ settings: { entries: [] }, resources: [], skills: [], rules: [] }),
  ompCapabilitiesDeleteResource: () =>
    Effect.succeed({ settings: { entries: [] }, resources: [], skills: [], rules: [] }),
  streamChanges: Stream.empty,
});

export const makeProviderRegistryLayer = (providers: ReadonlyArray<ServerProvider> = []) =>
  Layer.succeed(ProviderRegistry, makeProviderRegistryMock(providers));
