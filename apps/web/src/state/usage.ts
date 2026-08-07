import { makeEnvironmentHttpApiClient } from "@t3tools/client-runtime/rpc";
import type {
  EnvironmentId,
  EnvironmentUsageSnapshot,
  UsageActivityCount,
  UsageDailyTotals,
  UsageModelTotals,
  UsageProvider,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { primaryEnvironmentHttpLayer } from "../environments/primary/httpLayer";
import { readPreparedConnection } from "./session";
import { useEnvironments } from "./environments";

/**
 * Usage data lives on each host, because each one owns the agent session logs
 * its own runs wrote. The page therefore queries every connected environment
 * and merges client side. An environment that fails or is offline degrades to
 * an error row instead of blanking the whole page.
 */

export type EnvironmentUsageEntry = {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly snapshot: EnvironmentUsageSnapshot | null;
  readonly error: string | null;
};

export type MergedUsage = {
  readonly costUsd: number;
  readonly totalTokens: number;
  readonly cacheReadTokens: number;
  readonly billableInputTokens: number;
  readonly messages: number;
  readonly models: ReadonlyArray<UsageModelTotals>;
  readonly daily: ReadonlyArray<UsageDailyTotals>;
  readonly tools: ReadonlyArray<UsageActivityCount>;
  readonly skills: ReadonlyArray<UsageActivityCount>;
  readonly subagents: ReadonlyArray<UsageActivityCount>;
  readonly turnsByHour: ReadonlyArray<number>;
  readonly totalTurns: number;
  readonly totalThreads: number;
  readonly toolCalls: number;
  readonly toolFailures: number;
  readonly linesAdded: number;
  readonly linesDeleted: number;
  readonly firstDate: string | undefined;
  readonly lastDate: string | undefined;
};

const sumCounts = (
  lists: ReadonlyArray<ReadonlyArray<UsageActivityCount>>,
): Array<UsageActivityCount> => {
  const totals = new Map<string, number>();
  for (const list of lists) {
    for (const item of list) totals.set(item.name, (totals.get(item.name) ?? 0) + item.count);
  }
  return [...totals.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
};

/** Same model on two hosts is one row; cost and tokens add. */
const mergeModels = (
  snapshots: ReadonlyArray<EnvironmentUsageSnapshot>,
): Array<UsageModelTotals> => {
  const merged = new Map<string, UsageModelTotals>();
  for (const snapshot of snapshots) {
    for (const model of snapshot.models) {
      const key = `${model.provider}:${model.model}`;
      const existing = merged.get(key);
      if (existing === undefined) {
        merged.set(key, model);
        continue;
      }
      merged.set(key, {
        model: model.model,
        provider: model.provider,
        costUsd: existing.costUsd + model.costUsd,
        messages: existing.messages + model.messages,
        pricingKnown: existing.pricingKnown && model.pricingKnown,
        tokens: {
          inputTokens: existing.tokens.inputTokens + model.tokens.inputTokens,
          outputTokens: existing.tokens.outputTokens + model.tokens.outputTokens,
          cacheReadTokens: existing.tokens.cacheReadTokens + model.tokens.cacheReadTokens,
          cacheWriteTokens: existing.tokens.cacheWriteTokens + model.tokens.cacheWriteTokens,
          reasoningTokens: existing.tokens.reasoningTokens + model.tokens.reasoningTokens,
        },
      });
    }
  }
  return [...merged.values()].sort((a, b) => b.costUsd - a.costUsd);
};

const mergeDaily = (
  snapshots: ReadonlyArray<EnvironmentUsageSnapshot>,
): Array<UsageDailyTotals> => {
  const byDate = new Map<string, Map<UsageProvider, { costUsd: number; totalTokens: number }>>();
  for (const snapshot of snapshots) {
    for (const day of snapshot.daily) {
      const providers = byDate.get(day.date) ?? new Map();
      for (const entry of day.byProvider) {
        const existing = providers.get(entry.provider) ?? { costUsd: 0, totalTokens: 0 };
        providers.set(entry.provider, {
          costUsd: existing.costUsd + entry.costUsd,
          totalTokens: existing.totalTokens + entry.totalTokens,
        });
      }
      byDate.set(day.date, providers);
    }
  }
  return [...byDate.entries()]
    .map(([date, providers]) => {
      const byProvider = [...providers.entries()]
        .map(([provider, totals]) => ({ provider, ...totals }))
        .sort((a, b) => a.provider.localeCompare(b.provider));
      return {
        date,
        costUsd: byProvider.reduce((sum, item) => sum + item.costUsd, 0),
        totalTokens: byProvider.reduce((sum, item) => sum + item.totalTokens, 0),
        byProvider,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
};

export function mergeUsage(entries: ReadonlyArray<EnvironmentUsageEntry>): MergedUsage {
  const snapshots = entries.flatMap((entry) => (entry.snapshot === null ? [] : [entry.snapshot]));
  const turnsByHour = Array.from({ length: 24 }, () => 0);
  for (const snapshot of snapshots) {
    snapshot.activity.turnsByHour.forEach((count, hour) => {
      if (hour < 24) turnsByHour[hour] = (turnsByHour[hour] ?? 0) + count;
    });
  }
  const dates = snapshots
    .flatMap((snapshot) => [snapshot.firstDate, snapshot.lastDate])
    .filter((date): date is string => date !== undefined)
    .sort();

  const sum = (pick: (snapshot: EnvironmentUsageSnapshot) => number): number =>
    snapshots.reduce((total, snapshot) => total + pick(snapshot), 0);

  return {
    costUsd: sum((snapshot) => snapshot.costUsd),
    totalTokens: sum(
      (snapshot) =>
        snapshot.tokens.inputTokens +
        snapshot.tokens.outputTokens +
        snapshot.tokens.cacheReadTokens +
        snapshot.tokens.cacheWriteTokens,
    ),
    cacheReadTokens: sum((snapshot) => snapshot.tokens.cacheReadTokens),
    billableInputTokens: sum(
      (snapshot) =>
        snapshot.tokens.inputTokens +
        snapshot.tokens.cacheReadTokens +
        snapshot.tokens.cacheWriteTokens,
    ),
    messages: sum((snapshot) => snapshot.messages),
    models: mergeModels(snapshots),
    daily: mergeDaily(snapshots),
    tools: sumCounts(snapshots.map((snapshot) => snapshot.activity.tools)),
    skills: sumCounts(snapshots.map((snapshot) => snapshot.activity.skills)),
    subagents: sumCounts(snapshots.map((snapshot) => snapshot.activity.subagents)),
    turnsByHour,
    totalTurns: sum((snapshot) => snapshot.activity.totalTurns),
    totalThreads: sum((snapshot) => snapshot.activity.totalThreads),
    toolCalls: sum((snapshot) => snapshot.activity.toolCalls),
    toolFailures: sum((snapshot) => snapshot.activity.toolFailures),
    linesAdded: sum((snapshot) => snapshot.activity.linesAdded),
    linesDeleted: sum((snapshot) => snapshot.activity.linesDeleted),
    firstDate: dates.at(0),
    lastDate: dates.at(-1),
  };
}

/** Any failure reaching one environment, flattened so callers handle one type. */
export class UsageFetchError extends Data.TaggedError("UsageFetchError")<{
  readonly cause: unknown;
}> {}

const fetchSnapshot = (
  httpBaseUrl: string,
  sinceDate: string,
): Effect.Effect<EnvironmentUsageSnapshot, UsageFetchError> =>
  Effect.gen(function* () {
    const client = yield* makeEnvironmentHttpApiClient(httpBaseUrl);
    return yield* client.usage.snapshot({ headers: {}, payload: { sinceDate } });
  }).pipe(
    Effect.provide(primaryEnvironmentHttpLayer),
    Effect.mapError((cause) => new UsageFetchError({ cause })),
  );

const isoDaysAgo = (days: number): string => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
};

export function useUsage(windowDays: number) {
  const { environments } = useEnvironments();
  const [entries, setEntries] = useState<ReadonlyArray<EnvironmentUsageEntry>>([]);
  const [isLoading, setIsLoading] = useState(true);
  const requestId = useRef(0);

  const targets = useMemo(
    () =>
      environments.map((environment) => ({
        environmentId: environment.environmentId,
        label: environment.label,
      })),
    [environments],
  );

  const refresh = useCallback(async () => {
    const id = requestId.current + 1;
    requestId.current = id;
    setIsLoading(true);
    const sinceDate = isoDaysAgo(windowDays);

    const results = await Promise.all(
      targets.map(async (target): Promise<EnvironmentUsageEntry> => {
        const connection = readPreparedConnection(target.environmentId);
        if (connection === null) {
          return { ...target, snapshot: null, error: "Not connected" };
        }
        try {
          const snapshot = await Effect.runPromise(
            fetchSnapshot(connection.httpBaseUrl, sinceDate),
          );
          return { ...target, snapshot, error: null };
        } catch {
          return { ...target, snapshot: null, error: "Unavailable" };
        }
      }),
    );

    // A slower earlier request must not overwrite a newer one.
    if (requestId.current !== id) return;
    setEntries(results);
    setIsLoading(false);
  }, [targets, windowDays]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const merged = useMemo(() => mergeUsage(entries), [entries]);
  return { entries, merged, isLoading, refresh };
}
