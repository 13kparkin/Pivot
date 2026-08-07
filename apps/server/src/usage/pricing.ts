/**
 * Per-million-token list prices, mirroring the model set ccusage resolves from
 * models.dev and LiteLLM. Kept as a local table so usage reporting works
 * offline; refresh it when a model ships or a price changes.
 *
 * Slugs are matched longest-prefix-first, so dated variants such as
 * `claude-haiku-4-5-20251001` fall back to their family entry.
 */
export type ModelPricing = {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  /**
   * Multiplier applied to the whole request in fast mode. Codex fast mode is
   * billed at a premium; missing it understates spend by ~2x.
   */
  readonly fastMultiplier?: number;
};

/**
 * 1h cache writes cost more than the 5m default. Applied as a multiple of the
 * model's input rate, matching ccusage's cost model.
 */
export const CACHE_WRITE_1H_INPUT_MULTIPLIER = 2;

const PRICING: Readonly<Record<string, ModelPricing>> = {
  // Anthropic
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, fastMultiplier: 2 },
  "claude-opus-4-7": {
    input: 15,
    output: 75,
    cacheRead: 1.5,
    cacheWrite: 18.75,
    fastMultiplier: 6,
  },
  "claude-opus-4-6": {
    input: 15,
    output: 75,
    cacheRead: 1.5,
    cacheWrite: 18.75,
    fastMultiplier: 6,
  },
  "claude-opus-4": { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-sonnet-4": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "claude-haiku-4": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "claude-3-5-haiku": { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },

  // OpenAI / Codex
  "gpt-5.6-sol": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0, fastMultiplier: 2 },
  "gpt-5.6-terra": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0, fastMultiplier: 2 },
  "gpt-5.6-luna": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0, fastMultiplier: 2 },
  "gpt-5.6": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  "gpt-5.5": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0, fastMultiplier: 2.5 },
  "gpt-5.4": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0, fastMultiplier: 2 },
  "gpt-5.3-codex": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0, fastMultiplier: 2 },
  "gpt-5": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  "kindle-alpha": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0, fastMultiplier: 2 },
  "codex-auto-review": { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },

  // Other providers reachable through the same CLIs
  "kimi-k3": { input: 0.6, output: 2.5, cacheRead: 0.06, cacheWrite: 0.75 },
};

const SLUGS_BY_LENGTH = Object.keys(PRICING).sort((a, b) => b.length - a.length);

/**
 * A prefix only matches on a version boundary, so `claude-haiku-4-5-20251001`
 * resolves to the `claude-haiku-4-5` family while an unrelated `gpt-5000` does
 * not silently inherit `gpt-5` pricing.
 */
const matchesFamily = (slug: string, family: string): boolean =>
  slug.startsWith(family) &&
  (slug.length === family.length || /[-_@:.]/.test(slug[family.length] ?? ""));

/** Returns undefined for unknown slugs so callers can surface them explicitly. */
export function lookupPricing(model: string): ModelPricing | undefined {
  const slug = model.trim().toLowerCase();
  const direct = PRICING[slug];
  if (direct !== undefined) return direct;
  const family = SLUGS_BY_LENGTH.find((candidate) => matchesFamily(slug, candidate));
  return family === undefined ? undefined : PRICING[family];
}

export type CostInput = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  /** 5m ephemeral cache writes, billed at the model's cache-write rate. */
  readonly cacheWrite5mTokens: number;
  /** 1h ephemeral cache writes, billed as a multiple of the input rate. */
  readonly cacheWrite1hTokens: number;
  readonly fast: boolean;
};

export function calculateCostUsd(usage: CostInput, pricing: ModelPricing): number {
  const perMillion =
    usage.inputTokens * pricing.input +
    usage.outputTokens * pricing.output +
    usage.cacheReadTokens * pricing.cacheRead +
    usage.cacheWrite5mTokens * pricing.cacheWrite +
    usage.cacheWrite1hTokens * pricing.input * CACHE_WRITE_1H_INPUT_MULTIPLIER;
  const multiplier = usage.fast ? (pricing.fastMultiplier ?? 1) : 1;
  return (perMillion / 1_000_000) * multiplier;
}
