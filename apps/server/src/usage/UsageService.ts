import type { EnvironmentUsageSnapshot } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { readActivitySummary } from "./activityUsage.ts";
import { readLocalAgentUsage } from "./localAgentUsage.ts";

/** Scans cost real IO, so a snapshot is reused briefly rather than recomputed per request. */
const CACHE_TTL_MILLIS = Duration.toMillis(Duration.seconds(60));
const DEFAULT_WINDOW_DAYS = 30;

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

export const UsageServiceLayer = Layer.effect(UsageService)(
  Effect.gen(function* () {
    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
    // Captured once so the returned effects carry no outstanding requirements.
    const sql = yield* SqlClient.SqlClient;

    // Keyed by the resolved window so a narrower request cannot serve a wider
    // cached answer, or the reverse.
    const cache = new Map<
      string,
      { readonly at: number; readonly snapshot: EnvironmentUsageSnapshot }
    >();

    const build = (sinceDate: string): Effect.Effect<EnvironmentUsageSnapshot> =>
      Effect.gen(function* () {
        const descriptor = yield* serverEnvironment.getDescriptor;
        const generatedAt = DateTime.formatIso(yield* DateTime.now);
        const activity = yield* readActivitySummary(`${sinceDate}T00:00:00.000Z`).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        );
        const local = yield* Effect.tryPromise(() => readLocalAgentUsage({ sinceDate })).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Failed to read local agent usage logs", { cause }).pipe(
              Effect.as(undefined),
            ),
          ),
        );

        return {
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
      });

    return {
      getSnapshot: (sinceDate) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const resolved =
            sinceDate ??
            DateTime.formatIso(DateTime.subtract(now, { days: DEFAULT_WINDOW_DAYS })).slice(0, 10);

          const nowMillis = yield* Clock.currentTimeMillis;
          const cached = cache.get(resolved);
          if (cached !== undefined && nowMillis - cached.at < CACHE_TTL_MILLIS) {
            return cached.snapshot;
          }
          const snapshot = yield* build(resolved);
          cache.set(resolved, { at: nowMillis, snapshot });
          return snapshot;
        }),
    };
  }),
);
