import type { UsageActivityCount, UsageModelTotals } from "@t3tools/contracts";
import { RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { type EnvironmentUsageEntry, type MergedUsage, useUsage } from "../../state/usage";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

/**
 * Usage overview: cost and tokens read from the agents' own local session
 * logs, joined with behavioral counters from T3 Code's event log, merged
 * across every connected environment.
 */

const WINDOWS = [
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
] as const;

const usd = (value: number): string =>
  value >= 1000
    ? `$${Math.round(value).toLocaleString("en-US")}`
    : `$${value.toFixed(value < 10 ? 2 : 0)}`;

const compactTokens = (value: number): string => {
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return String(value);
};

const percent = (numerator: number, denominator: number): string =>
  denominator === 0 ? "0%" : `${((numerator / denominator) * 100).toFixed(1)}%`;

function StatTile({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="min-w-0 px-4 py-3 sm:px-5">
      <div className="truncate text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70">
        {label}
      </div>
      <div className="mt-1 truncate font-mono text-lg font-semibold tabular-nums text-foreground">
        {value}
      </div>
      {detail === undefined ? null : (
        <div className="mt-0.5 truncate text-[11px] text-muted-foreground/70">{detail}</div>
      )}
    </div>
  );
}

/**
 * Stacked columns, one per day, split by provider. Heights are percentages of
 * the busiest day so the chart needs no measurement pass.
 */
function DailyChart({ daily }: { daily: MergedUsage["daily"] }) {
  if (daily.length === 0) {
    return (
      <div className="px-4 py-8 text-xs text-muted-foreground sm:px-5">No usage recorded.</div>
    );
  }
  const max = Math.max(...daily.map((day) => day.costUsd), 0.01);
  return (
    <div className="px-4 sm:px-5">
      <div className="flex h-40 items-end gap-[3px]">
        {daily.map((day) => {
          const claude = day.byProvider.find((entry) => entry.provider === "claude")?.costUsd ?? 0;
          const codex = day.byProvider.find((entry) => entry.provider === "codex")?.costUsd ?? 0;
          return (
            <div
              key={day.date}
              className="group flex h-full min-w-0 flex-1 flex-col justify-end gap-[2px]"
              title={`${day.date}: ${usd(day.costUsd)} (Claude ${usd(claude)}, Codex ${usd(codex)})`}
            >
              <div
                className="w-full rounded-t-[3px] bg-sky-500 transition-[filter] group-hover:brightness-125"
                style={{ height: `${(codex / max) * 100}%` }}
              />
              <div
                className="w-full bg-orange-500 transition-[filter] group-hover:brightness-125"
                style={{ height: `${(claude / max) * 100}%` }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex items-center justify-between text-[10px] font-medium text-muted-foreground/70">
        <span className="font-mono">{daily.at(0)?.date}</span>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-[2px] bg-orange-500" />
            Claude
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-[2px] bg-sky-500" />
            Codex
          </span>
        </span>
        <span className="font-mono">{daily.at(-1)?.date}</span>
      </div>
    </div>
  );
}

function BarList({
  items,
  emptyLabel,
  accent,
}: {
  items: ReadonlyArray<UsageActivityCount>;
  emptyLabel: string;
  accent: string;
}) {
  if (items.length === 0) {
    return <div className="px-4 py-4 text-xs text-muted-foreground sm:px-5">{emptyLabel}</div>;
  }
  const max = items[0]?.count ?? 1;
  return (
    <div className="space-y-1 px-4 py-1 sm:px-5">
      {items.slice(0, 8).map((item) => (
        <div
          key={item.name}
          className="grid grid-cols-[minmax(0,7rem)_1fr_auto] items-center gap-2"
        >
          <span className="truncate text-xs text-foreground/90">{item.name}</span>
          <span className="h-2 overflow-hidden rounded-[2px] bg-muted">
            <span
              className={cn("block h-full rounded-r-[2px]", accent)}
              style={{ width: `${Math.max(2, (item.count / max) * 100)}%` }}
            />
          </span>
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
            {item.count.toLocaleString("en-US")}
          </span>
        </div>
      ))}
    </div>
  );
}

function ModelsTable({
  models,
  totalCost,
}: {
  models: ReadonlyArray<UsageModelTotals>;
  totalCost: number;
}) {
  if (models.length === 0) {
    return (
      <div className="px-4 py-4 text-xs text-muted-foreground sm:px-5">No models recorded.</div>
    );
  }
  return (
    <div className="overflow-x-auto px-4 sm:px-5">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b border-border/60 text-[10px] uppercase tracking-[0.07em] text-muted-foreground/70">
            <th className="py-2 pr-3 text-left font-medium">Model</th>
            <th className="py-2 pr-3 text-right font-medium">Tokens</th>
            <th className="py-2 pr-3 text-right font-medium">Messages</th>
            <th className="py-2 text-right font-medium">Cost</th>
          </tr>
        </thead>
        <tbody>
          {models.map((model) => {
            const tokens =
              model.tokens.inputTokens +
              model.tokens.outputTokens +
              model.tokens.cacheReadTokens +
              model.tokens.cacheWriteTokens;
            return (
              <tr
                key={`${model.provider}:${model.model}`}
                className="border-b border-border/30 last:border-0"
              >
                <td className="py-2 pr-3">
                  <span className="flex items-center gap-2">
                    <span
                      className={cn(
                        "size-2 shrink-0 rounded-[2px]",
                        model.provider === "codex" ? "bg-sky-500" : "bg-orange-500",
                      )}
                    />
                    <span className="truncate font-medium text-foreground">{model.model}</span>
                  </span>
                </td>
                <td className="py-2 pr-3 text-right font-mono tabular-nums text-muted-foreground">
                  {compactTokens(tokens)}
                </td>
                <td className="py-2 pr-3 text-right font-mono tabular-nums text-muted-foreground">
                  {model.messages.toLocaleString("en-US")}
                </td>
                <td className="py-2 text-right font-mono tabular-nums text-foreground">
                  {model.pricingKnown ? (
                    usd(model.costUsd)
                  ) : (
                    <span
                      className="text-amber-600 dark:text-amber-400"
                      title="No pricing entry matched this model, so its cost is not counted."
                    >
                      unpriced
                    </span>
                  )}
                  {totalCost > 0 && model.pricingKnown ? (
                    <span className="ml-2 text-[10px] text-muted-foreground/60">
                      {percent(model.costUsd, totalCost)}
                    </span>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function EnvironmentsTable({ entries }: { entries: ReadonlyArray<EnvironmentUsageEntry> }) {
  return (
    <div className="overflow-x-auto px-4 sm:px-5">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-b border-border/60 text-[10px] uppercase tracking-[0.07em] text-muted-foreground/70">
            <th className="py-2 pr-3 text-left font-medium">Environment</th>
            <th className="py-2 pr-3 text-right font-medium">Sessions</th>
            <th className="py-2 pr-3 text-right font-medium">Tokens</th>
            <th className="py-2 text-right font-medium">Cost</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => {
            const snapshot = entry.snapshot;
            const tokens =
              snapshot === null
                ? 0
                : snapshot.tokens.inputTokens +
                  snapshot.tokens.outputTokens +
                  snapshot.tokens.cacheReadTokens +
                  snapshot.tokens.cacheWriteTokens;
            return (
              <tr key={entry.environmentId} className="border-b border-border/30 last:border-0">
                <td className="py-2 pr-3">
                  <span className="flex items-center gap-2">
                    <span
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        entry.error === null ? "bg-emerald-500" : "bg-muted-foreground/40",
                      )}
                    />
                    <span className="truncate font-medium text-foreground">{entry.label}</span>
                    {entry.error === null ? null : (
                      <span className="text-[10px] text-muted-foreground/70">{entry.error}</span>
                    )}
                  </span>
                </td>
                <td className="py-2 pr-3 text-right font-mono tabular-nums text-muted-foreground">
                  {snapshot?.sessions.toLocaleString("en-US") ?? "-"}
                </td>
                <td className="py-2 pr-3 text-right font-mono tabular-nums text-muted-foreground">
                  {snapshot === null ? "-" : compactTokens(tokens)}
                </td>
                <td className="py-2 text-right font-mono tabular-nums text-foreground">
                  {snapshot === null ? "-" : usd(snapshot.costUsd)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function HourStrip({ turnsByHour }: { turnsByHour: ReadonlyArray<number> }) {
  const max = Math.max(...turnsByHour, 1);
  return (
    <div className="px-4 sm:px-5">
      <div className="grid grid-cols-24 gap-[2px]">
        {turnsByHour.map((count, hour) => (
          <span
            key={`hour-${String(hour)}`}
            className="h-7 rounded-[2px] bg-primary"
            style={{ opacity: count === 0 ? 0.06 : 0.2 + (count / max) * 0.8 }}
            title={`${String(hour).padStart(2, "0")}:00 · ${count} turns`}
          />
        ))}
      </div>
      <div className="mt-1.5 flex justify-between font-mono text-[10px] text-muted-foreground/60">
        <span>00</span>
        <span>06</span>
        <span>12</span>
        <span>18</span>
        <span>23</span>
      </div>
    </div>
  );
}

export function UsageSettings() {
  const [windowDays, setWindowDays] = useState<number>(30);
  const { entries, merged, isLoading, refresh } = useUsage(windowDays);

  const rateLimit = entries
    .flatMap((entry) => entry.snapshot?.rateLimits ?? [])
    .sort((a, b) => b.usedPercent - a.usedPercent)
    .at(0);

  const unpriced = merged.models.filter((model) => !model.pricingKnown);

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Usage"
        headerAction={
          <span className="flex items-center gap-2">
            <span className="flex overflow-hidden rounded-md border border-border">
              {WINDOWS.map((option) => (
                <button
                  key={option.label}
                  type="button"
                  aria-pressed={windowDays === option.days}
                  onClick={() => setWindowDays(option.days)}
                  className={cn(
                    "px-2.5 py-1 text-xs transition-colors",
                    windowDays === option.days
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {option.label}
                </button>
              ))}
            </span>
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={isLoading}
              aria-label="Refresh usage"
              className="inline-flex size-7 items-center justify-center rounded-md border border-border text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              <RefreshCwIcon className="size-3.5" />
            </button>
          </span>
        }
      >
        <div className="relative grid grid-cols-2 border-y border-border/60 sm:grid-cols-3">
          <StatTile
            label="Spend"
            value={usd(merged.costUsd)}
            detail={
              merged.firstDate === undefined
                ? "no data yet"
                : `${merged.firstDate} to ${merged.lastDate}`
            }
          />
          <StatTile
            label="Tokens"
            value={compactTokens(merged.totalTokens)}
            detail={`${merged.messages.toLocaleString("en-US")} messages`}
          />
          <StatTile
            label="Cache hit"
            value={percent(merged.cacheReadTokens, merged.billableInputTokens)}
            detail={`${compactTokens(merged.cacheReadTokens)} reused`}
          />
          <StatTile
            label="Turns"
            value={merged.totalTurns.toLocaleString("en-US")}
            detail={`${merged.totalThreads.toLocaleString("en-US")} threads`}
          />
          <StatTile
            label="Tool success"
            value={percent(merged.toolCalls - merged.toolFailures, merged.toolCalls)}
            detail={`${merged.toolCalls.toLocaleString("en-US")} calls`}
          />
          <StatTile
            label={rateLimit === undefined ? "Code written" : "Weekly limit"}
            value={
              rateLimit === undefined
                ? `+${compactTokens(merged.linesAdded)}`
                : `${Math.round(rateLimit.usedPercent)}%`
            }
            detail={
              rateLimit === undefined
                ? `-${compactTokens(merged.linesDeleted)} removed`
                : `${rateLimit.planType ?? "plan"}, resets ${rateLimit.resetsAt?.slice(0, 10) ?? "soon"}`
            }
          />
        </div>
      </SettingsSection>

      <SettingsSection title="Spend per day">
        <DailyChart daily={merged.daily} />
      </SettingsSection>

      <SettingsSection title="Models">
        <ModelsTable models={merged.models} totalCost={merged.costUsd} />
        {unpriced.length === 0 ? null : (
          <p className="px-4 pt-3 text-[11px] text-muted-foreground sm:px-5">
            No pricing entry for {unpriced.map((model) => model.model).join(", ")}. Those rows show
            tokens but are excluded from the spend total.
          </p>
        )}
      </SettingsSection>

      <SettingsSection title="Environments">
        <EnvironmentsTable entries={entries} />
      </SettingsSection>

      <SettingsSection title="Turns by hour">
        <HourStrip turnsByHour={merged.turnsByHour} />
      </SettingsSection>

      <SettingsSection title="Tools">
        <BarList items={merged.tools} emptyLabel="No tool calls recorded." accent="bg-primary" />
      </SettingsSection>

      <SettingsSection title="Skills">
        <BarList items={merged.skills} emptyLabel="No skills invoked." accent="bg-emerald-500" />
      </SettingsSection>

      <SettingsSection title="Subagents">
        <BarList
          items={merged.subagents}
          emptyLabel="No subagents spawned."
          accent="bg-violet-500"
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
