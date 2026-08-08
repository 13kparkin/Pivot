/**
 * Account rate-limit views: the sidebar hover card and the usage page's
 * "Limits" strip. Both render whatever windows the server reports, so a
 * window a provider adds or brings back (Codex's paused 5-hour) appears
 * without a client change.
 *
 * @module AccountLimits
 */
import type { AccountLimitsSnapshot, AccountLimitsWindow } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { cn } from "../../lib/utils";
import { useAccountLimits } from "../../state/accountLimits";
import { formatAgo, formatResetAt, formatResetIn } from "../../usage/limitsFormat";
import { PROVIDER_COLOR, PROVIDER_LABEL, PROVIDER_MARK, PROVIDER_ORDER } from "./usageProviders";

/**
 * Reset countdowns and snapshot ages drift as time passes, not as data
 * changes; a coarse tick keeps them honest without re-fetching.
 */
function useNowMs(intervalMs = 30_000): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return nowMs;
}

const PLAN_LABEL: Record<string, string> = {
  max: "Max",
  pro: "Pro",
  plus: "Plus",
  team: "Team",
  enterprise: "Enterprise",
};

function formatPlan(plan: string | null): string | null {
  if (plan === null) return null;
  return PLAN_LABEL[plan] ?? plan.charAt(0).toUpperCase() + plan.slice(1);
}

function usageTone(usedPercent: number): string | undefined {
  if (usedPercent >= 95) return "text-red-400";
  if (usedPercent >= 80) return "text-amber-400";
  return undefined;
}

function LimitMeter({ window, color }: { window: AccountLimitsWindow; color: string }) {
  return (
    <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
      <div
        className="h-full rounded-full"
        style={{
          width: `${Math.min(100, Math.max(0, window.usedPercent))}%`,
          backgroundColor: color,
        }}
      />
    </div>
  );
}

function SnapshotFreshness({
  snapshot,
  nowMs,
}: {
  snapshot: AccountLimitsSnapshot;
  nowMs: number;
}) {
  return (
    <span className="text-[10px] text-muted-foreground">
      {snapshot.source === "transcript" ? "last session · " : ""}
      {formatAgo(snapshot.asOf, nowMs)}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Sidebar hover card
// ---------------------------------------------------------------------------

/** Compact per-provider availability, shown on hovering the Usage button. */
export function AccountLimitsHoverCard() {
  const { snapshots, isPending } = useAccountLimits();
  const nowMs = useNowMs();

  if (isPending && snapshots.size === 0) {
    return <p className="px-1 py-2 text-xs text-muted-foreground">Loading limits…</p>;
  }

  return (
    <div className="flex w-60 flex-col gap-2.5 p-1.5">
      {PROVIDER_ORDER.map((provider) => {
        const snapshot = snapshots.get(provider);
        const Mark = PROVIDER_MARK[provider];
        const plan = formatPlan(snapshot?.plan ?? null);
        return (
          <div key={provider} className="flex flex-col gap-1">
            <div className="flex items-baseline gap-1.5">
              <Mark className="size-3 shrink-0 self-center" />
              <span className="text-xs font-medium text-foreground">
                {PROVIDER_LABEL[provider]}
              </span>
              {plan !== null ? (
                <span className="text-[10px] text-muted-foreground">{plan}</span>
              ) : null}
              <span className="ml-auto">
                {snapshot !== undefined ? (
                  <SnapshotFreshness snapshot={snapshot} nowMs={nowMs} />
                ) : null}
              </span>
            </div>
            {snapshot === undefined || snapshot.windows.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">No limit data yet</p>
            ) : (
              snapshot.windows.map((window) => (
                <div key={window.id} className="flex items-center gap-2">
                  <span className="w-8 shrink-0 text-[10px] text-muted-foreground">
                    {window.label}
                  </span>
                  <LimitMeter window={window} color={PROVIDER_COLOR[provider]} />
                  <span
                    className={cn(
                      "w-8 shrink-0 text-right text-[11px] tabular-nums text-foreground",
                      usageTone(window.usedPercent),
                    )}
                  >
                    {Math.round(window.usedPercent)}%
                  </span>
                  <span className="w-14 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
                    {formatResetAt(window.resetsAt, nowMs) ?? ""}
                  </span>
                </div>
              ))
            )}
          </div>
        );
      })}
      <p className="border-t border-border pt-1.5 text-[10px] text-muted-foreground">
        % used · click for details
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Usage page section
// ---------------------------------------------------------------------------

/** The "Limits" strip above the analytics: one column per provider. */
export function AccountLimitsSection() {
  const { snapshots, isPending } = useAccountLimits();
  const nowMs = useNowMs();

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-foreground">Limits</h2>
      <div className="grid gap-x-12 gap-y-4 sm:grid-cols-2">
        {PROVIDER_ORDER.map((provider) => {
          const snapshot = snapshots.get(provider);
          const Mark = PROVIDER_MARK[provider];
          const plan = formatPlan(snapshot?.plan ?? null);
          return (
            <div key={provider} className="flex flex-col gap-1.5">
              <div className="flex items-baseline gap-2">
                <Mark className="size-3.5 shrink-0 self-center" />
                <span className="text-sm font-medium text-foreground">
                  {PROVIDER_LABEL[provider]}
                </span>
                {plan !== null ? (
                  <span className="text-xs text-muted-foreground">{plan}</span>
                ) : null}
                <span className="ml-auto">
                  {snapshot !== undefined ? (
                    <SnapshotFreshness snapshot={snapshot} nowMs={nowMs} />
                  ) : null}
                </span>
              </div>
              {snapshot === undefined || snapshot.windows.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {isPending && snapshot === undefined
                    ? "Loading…"
                    : `No limit data yet. Run a ${PROVIDER_LABEL[provider]} session.`}
                </p>
              ) : (
                snapshot.windows.map((window) => {
                  const resetAt = formatResetAt(window.resetsAt, nowMs);
                  const resetIn = formatResetIn(window.resetsAt, nowMs);
                  return (
                    <div key={window.id} className="flex items-center gap-3">
                      <span className="w-10 shrink-0 text-xs text-muted-foreground">
                        {window.label}
                      </span>
                      <LimitMeter window={window} color={PROVIDER_COLOR[provider]} />
                      <span
                        className={cn(
                          "w-9 shrink-0 text-right text-xs font-medium tabular-nums text-foreground",
                          usageTone(window.usedPercent),
                        )}
                      >
                        {Math.round(window.usedPercent)}%
                      </span>
                      <span className="w-36 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                        {resetAt === null
                          ? "no traffic yet"
                          : `resets ${resetAt}${resetIn === null ? "" : ` · ${resetIn}`}`}
                      </span>
                    </div>
                  );
                })
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
