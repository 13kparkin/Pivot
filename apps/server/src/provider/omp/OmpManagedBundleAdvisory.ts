/**
 * Fold managed omp + rtk release checks into one provider versionAdvisory.
 *
 * @module provider/omp/OmpManagedBundleAdvisory
 */
import type { ServerProvider } from "@t3tools/contracts";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as Crypto from "effect/Crypto";

import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
  ProviderVersionCache,
} from "../providerMaintenance.ts";
import { makeRtkManagedBinary, RTK_VERSION_CACHE_KEY } from "./RtkManagedBinary.ts";

const LATEST_VERSION_CACHE_TTL_MS = 60 * 60 * 1_000;
export const RTK_BEHIND_MESSAGE =
  "Managed rtk update available. Install updates omp and rtk together.";

export function isManagedRtkBehind(input: {
  readonly rtkCurrent: string | null;
  readonly rtkLatest: string | null;
  readonly rtkMissing: boolean;
}): boolean {
  if (!input.rtkLatest) {
    return false;
  }
  if (input.rtkMissing || !input.rtkCurrent) {
    return true;
  }
  return compareSemverVersions(input.rtkCurrent, input.rtkLatest) < 0;
}

export function applyManagedRtkBehindAdvisory(
  snapshot: ServerProvider,
  input: {
    readonly rtkCurrent: string | null;
    readonly rtkLatest: string | null;
    readonly rtkMissing: boolean;
    readonly checkedAt: string;
  },
): ServerProvider {
  if (!isManagedRtkBehind(input)) {
    return snapshot;
  }
  const advisory = snapshot.versionAdvisory;
  if (!advisory) {
    return snapshot;
  }
  const ompAlreadyBehind = advisory.status === "behind_latest";
  return {
    ...snapshot,
    versionAdvisory: {
      ...advisory,
      status: "behind_latest",
      checkedAt: input.checkedAt,
      message: ompAlreadyBehind ? advisory.message : RTK_BEHIND_MESSAGE,
    },
  };
}

export const enrichOmpManagedBundleVersionAdvisory = Effect.fn(
  "enrichOmpManagedBundleVersionAdvisory",
)(function* (
  snapshot: ServerProvider,
  maintenanceCapabilities: ProviderMaintenanceCapabilities,
  options: {
    readonly baseDir: string;
    readonly enableProviderUpdateChecks: boolean | undefined;
    /**
     * When false, only omp’s own advisory is applied (PATH/override omp).
     * When true, missing/outdated managed rtk also forces behind_latest.
     */
    readonly checkManagedRtk: boolean;
  },
) {
  const withOmp = yield* enrichProviderSnapshotWithVersionAdvisory(
    snapshot,
    maintenanceCapabilities,
    {
      enableProviderUpdateChecks: options.enableProviderUpdateChecks,
    },
  );

  if (
    options.enableProviderUpdateChecks === false ||
    !snapshot.enabled ||
    !options.checkManagedRtk
  ) {
    return withOmp;
  }

  const rtk = yield* makeRtkManagedBinary({ baseDir: options.baseDir });
  const rtkStatus = yield* rtk.resolve;
  if (rtkStatus.status === "unsupported") {
    return withOmp;
  }

  const latestVersionCache = yield* ProviderVersionCache;
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  const cached = latestVersionCache.get(RTK_VERSION_CACHE_KEY);
  let rtkLatest = cached && cached.expiresAt > now ? cached.version : null;
  if (!(cached && cached.expiresAt > now)) {
    rtkLatest = yield* rtk.fetchLatestReleaseVersion;
    latestVersionCache.set(RTK_VERSION_CACHE_KEY, {
      expiresAt: now + LATEST_VERSION_CACHE_TTL_MS,
      version: rtkLatest,
    });
  }

  return applyManagedRtkBehindAdvisory(withOmp, {
    rtkCurrent: rtkStatus.status === "available" ? rtkStatus.version : null,
    rtkLatest,
    rtkMissing: rtkStatus.status === "missing",
    checkedAt: DateTime.formatIso(yield* DateTime.now),
  });
});

export type EnrichOmpManagedBundleVersionAdvisoryEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path;
