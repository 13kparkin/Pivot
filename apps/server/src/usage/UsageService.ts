import type { EnvironmentUsageSnapshot } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { readActivitySummary } from "./activityUsage.ts";
import { readLocalAgentUsage } from "./localAgentUsage.ts";

/** Scans cost real IO, so a snapshot is reused briefly rather than recomputed per request. */
const CACHE_TTL_MILLIS = Duration.toMillis(Duration.seconds(60));
const DEFAULT_WINDOW_DAYS = 30;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Distinct windows a client realistically asks for; anything past this evicts oldest-first. */
const MAX_CACHE_ENTRIES = 8;

const emptyTokens = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
} as const;

export class UsageService extends Context.Service<
  UsageService,
  {
    readonly getSnapshot: (
      sinceDate: string | undefined,
    ) => Effect.Effect<EnvironmentUsageSnapshot>;
  }
>()("t3/usage/UsageService") {}

export const make = Effect.gen(function* () {
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  // Agent session logs live under the OS home, not the server's base directory,
  // so isolating them needs an explicit override. Tests and sandboxed runs set
  // this; in normal operation it is absent and the OS home is used.
  const agentLogHome = yield* Config.string("T3CODE_AGENT_LOG_HOME").pipe(Config.option);
  // Captured once so the returned effects carry no outstanding requirements.
  const sql = yield* SqlClient.SqlClient;

  // Keyed by the resolved window so a narrower request cannot serve a wider
  // cached answer, or the reverse.
  const cache = new Map<
    string,
    { readonly at: number; readonly snapshot: EnvironmentUsageSnapshot }
  >();

  /** Snapshot plus whether the log scan actually succeeded. */
  const build = (
    sinceDate: string,
  ): Effect.Effect<{ snapshot: EnvironmentUsageSnapshot; complete: boolean }> =>
    Effect.gen(function* () {
      const descriptor = yield* serverEnvironment.getDescriptor;
      const generatedAt = DateTime.formatIso(yield* DateTime.now);
      const activity = yield* readActivitySummary(`${sinceDate}T00:00:00.000Z`).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
      );
      const local = yield* Effect.tryPromise(() =>
        readLocalAgentUsage({
          sinceDate,
          ...(Option.isSome(agentLogHome) ? { homeDir: agentLogHome.value } : {}),
        }),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to read local agent usage logs", { cause }).pipe(
            Effect.as(undefined),
          ),
        ),
      );

      const snapshot = {
        environmentId: descriptor.environmentId,
        generatedAt,
        firstDate: local?.firstDate,
        lastDate: local?.lastDate,
        costUsd: local?.costUsd ?? 0,
        tokens: local?.tokens ?? emptyTokens,
        messages: local?.messages ?? 0,
        sessions: local?.sessions ?? 0,
        models: local?.models ?? [],
        daily: local?.daily ?? [],
        projects: local?.projects ?? [],
        rateLimits: local?.rateLimits ?? [],
        sources: local?.sources ?? [],
        activity,
      } satisfies EnvironmentUsageSnapshot;
      return { snapshot, complete: local !== undefined };
    });

  return {
    getSnapshot: (sinceDate: string | undefined) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const fallback = DateTime.formatIso(
          DateTime.subtract(now, { days: DEFAULT_WINDOW_DAYS }),
        ).slice(0, 10);
        // The wire type is a plain string, so anything that is not a calendar
        // date falls back to the default window instead of reaching the query.
        const resolved = sinceDate !== undefined && ISO_DATE.test(sinceDate) ? sinceDate : fallback;

        const startedAt = yield* Clock.currentTimeMillis;
        const cached = cache.get(resolved);
        if (cached !== undefined && startedAt - cached.at < CACHE_TTL_MILLIS) {
          return cached.snapshot;
        }
        // Callers choose the window, so evict expired entries before inserting;
        // otherwise one entry accumulates per distinct date string and the map
        // grows without bound.
        for (const [key, entry] of cache) {
          if (startedAt - entry.at >= CACHE_TTL_MILLIS) cache.delete(key);
        }

        const { snapshot, complete } = yield* build(resolved);
        // Only cache a complete read, and stamp it on completion so a slow
        // scan does not immediately expire. A failed scan reports zeros once
        // rather than pinning the page at $0 for the whole TTL.
        if (complete) {
          const finishedAt = yield* Clock.currentTimeMillis;
          // Bounded even within one TTL window, so a burst of distinct dates
          // cannot pin unbounded memory until the entries age out.
          if (cache.size >= MAX_CACHE_ENTRIES) {
            const oldest = cache.keys().next();
            if (!oldest.done) cache.delete(oldest.value);
          }
          cache.set(resolved, { at: finishedAt, snapshot });
        }
        return snapshot;
      }),
  };
});

export const layer = Layer.effect(UsageService, make);
