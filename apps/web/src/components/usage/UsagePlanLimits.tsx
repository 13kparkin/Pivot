import type { UsagePlanLimit, UsagePlanProvider } from "@t3tools/contracts";

import { formatDateTimeShort, formatPercent } from "@t3tools/shared/usageFormat";

function planProviderLabel(provider: string): string {
  switch (provider) {
    case "openai-codex":
      return "Codex";
    case "opencode-go":
      return "OpenCode Go";
    case "cursor":
      return "Cursor";
    case "anthropic":
      return "Anthropic";
    default:
      return provider;
  }
}

function formatAmount(limit: UsagePlanLimit): string {
  const unit = limit.unit;
  if (unit === "percent") {
    const used =
      limit.usedFraction !== undefined ? formatPercent(limit.usedFraction) : `${limit.used}%`;
    if (limit.remainingFraction !== undefined) {
      return `${used} used · ${formatPercent(limit.remainingFraction)} left`;
    }
    if (limit.remaining !== undefined) {
      return `${used} used · ${limit.remaining}% left`;
    }
    return `${used} used`;
  }
  if (unit === "usd") {
    const used = `$${limit.used.toFixed(2)}`;
    if (limit.remaining !== undefined && limit.limit !== undefined) {
      return `${used} / $${limit.limit.toFixed(2)} · $${limit.remaining.toFixed(2)} left`;
    }
    if (limit.limit !== undefined) {
      return `${used} / $${limit.limit.toFixed(2)}`;
    }
    return used;
  }
  if (limit.remaining !== undefined && limit.limit !== undefined) {
    return `${limit.used} / ${limit.limit} ${unit} · ${limit.remaining} left`;
  }
  return `${limit.used} ${unit}`;
}

function usedBarFraction(limit: UsagePlanLimit): number {
  if (limit.usedFraction !== undefined) return Math.min(1, Math.max(0, limit.usedFraction));
  if (limit.limit !== undefined && limit.limit > 0) {
    return Math.min(1, Math.max(0, limit.used / limit.limit));
  }
  return 0;
}

function PlanLimitRow({ limit }: { readonly limit: UsagePlanLimit }) {
  const fraction = usedBarFraction(limit);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="text-foreground">{limit.label}</span>
        <span className="text-muted-foreground tabular-nums">{formatAmount(limit)}</span>
      </div>
      <div className="bg-muted h-1.5 overflow-hidden rounded-full">
        <div
          className="bg-foreground/80 h-full rounded-full"
          style={{ width: `${fraction * 100}%` }}
        />
      </div>
      {limit.resetsAtMs !== undefined ? (
        <div className="text-muted-foreground text-xs">
          Resets {formatDateTimeShort(new Date(limit.resetsAtMs).toISOString())}
        </div>
      ) : null}
    </div>
  );
}

export function UsagePlanLimits({
  planProviders,
}: {
  readonly planProviders: readonly UsagePlanProvider[];
}) {
  if (planProviders.length === 0) return null;

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="text-sm font-medium">Plan limits</h2>
        <p className="text-muted-foreground text-xs">
          Live from omp (subscription capacity, separate from token history below).
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {planProviders.map((provider) => (
          <div
            key={provider.provider}
            className="border-border/60 flex flex-col gap-3 rounded-lg border p-4"
          >
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-sm font-medium">{planProviderLabel(provider.provider)}</h3>
              {provider.planType ? (
                <span className="text-muted-foreground text-xs">{provider.planType}</span>
              ) : null}
            </div>
            {provider.limits.length === 0 ? (
              <p className="text-muted-foreground text-sm">No limits reported.</p>
            ) : (
              <div className="flex flex-col gap-3">
                {provider.limits.map((limit) => (
                  <PlanLimitRow key={limit.id} limit={limit} />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
