// Fixtures are written with the node APIs the reader itself uses.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { readLocalAgentUsage } from "./localAgentUsage.ts";
import { calculateCostUsd, lookupPricing } from "./pricing.ts";

const write = async (path: string, lines: ReadonlyArray<unknown>): Promise<void> => {
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
  await NodeFSP.writeFile(path, lines.map((line) => JSON.stringify(line)).join("\n"));
};

const claudeEntry = (options: {
  id: string;
  model?: string;
  cacheRead?: number;
  cacheWrite5m?: number;
}) => ({
  type: "assistant",
  timestamp: "2099-01-02T03:04:05.000Z",
  cwd: "/home/dev/acme",
  message: {
    id: options.id,
    model: options.model ?? "claude-opus-5",
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: options.cacheRead ?? 0,
      cache_creation: {
        ephemeral_5m_input_tokens: options.cacheWrite5m ?? 0,
        ephemeral_1h_input_tokens: 0,
      },
    },
  },
});

const codexTokenCount = (total: {
  input: number;
  cached: number;
  output: number;
  reasoning?: number;
}) => ({
  timestamp: "2099-01-02T03:04:05.000Z",
  type: "event_msg",
  payload: {
    type: "token_count",
    info: {
      total_token_usage: {
        input_tokens: total.input,
        cached_input_tokens: total.cached,
        output_tokens: total.output,
        reasoning_output_tokens: total.reasoning ?? 0,
      },
    },
    rate_limits: {
      plan_type: "pro",
      primary: { used_percent: 42, window_minutes: 10080, resets_at: 4102444800 },
    },
  },
});

const withFixture = async (
  build: (dirs: { claude: string; codex: string }) => Promise<void>,
): Promise<Awaited<ReturnType<typeof readLocalAgentUsage>>> => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-usage-"));
  const claude = NodePath.join(root, "claude");
  const codex = NodePath.join(root, "codex-sessions");
  try {
    await build({ claude, codex });
    return await readLocalAgentUsage({ claudeDirs: [claude], codexDir: codex });
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
};

describe("readLocalAgentUsage", () => {
  it("bills a Claude message once even when several session files repeat it", async () => {
    const result = await withFixture(async ({ claude }) => {
      const entry = claudeEntry({ id: "msg-1" });
      // A resumed session rewrites earlier turns into a new file.
      await write(NodePath.join(claude, "projects", "acme", "a.jsonl"), [entry]);
      await write(NodePath.join(claude, "projects", "acme", "b.jsonl"), [entry]);
    });

    expect(result.messages).toBe(1);
    const claudeSource = result.sources.find((source) => source.provider === "claude");
    expect(claudeSource?.recordsRead).toBe(2);
    expect(claudeSource?.duplicatesSkipped).toBe(1);
  });

  it("prices Claude cache writes above input and cache reads below it", async () => {
    const result = await withFixture(async ({ claude }) => {
      await write(NodePath.join(claude, "projects", "acme", "a.jsonl"), [
        claudeEntry({ id: "msg-1", cacheRead: 1_000_000, cacheWrite5m: 1_000_000 }),
      ]);
    });

    const pricing = lookupPricing("claude-opus-5");
    expect(pricing).toBeDefined();
    const expected = calculateCostUsd(
      {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 1_000_000,
        cacheWrite5mTokens: 1_000_000,
        cacheWrite1hTokens: 0,
        fast: false,
      },
      pricing!,
    );
    expect(result.costUsd).toBeCloseTo(expected, 6);
    // Cache write is the dominant term: it costs more per token than input.
    expect(result.costUsd).toBeGreaterThan(pricing!.cacheRead + pricing!.input);
  });

  it("turns cumulative Codex totals into per-turn deltas", async () => {
    const result = await withFixture(async ({ codex }) => {
      await write(NodePath.join(codex, "2099", "s.jsonl"), [
        { type: "turn_context", payload: { model: "gpt-5.6-sol", cwd: "/home/dev/acme" } },
        codexTokenCount({ input: 1000, cached: 800, output: 100 }),
        codexTokenCount({ input: 2500, cached: 2000, output: 250 }),
      ]);
    });

    const model = result.models.find((entry) => entry.model === "gpt-5.6-sol");
    // Totals are the last cumulative snapshot, not the sum of both snapshots.
    expect(model?.tokens.outputTokens).toBe(250);
    expect(model?.tokens.cacheReadTokens).toBe(2000);
    // Codex counts cached inside input, so fresh input is the remainder.
    expect(model?.tokens.inputTokens).toBe(500);
  });

  it("treats a backwards Codex snapshot as a compaction reset", async () => {
    const result = await withFixture(async ({ codex }) => {
      await write(NodePath.join(codex, "2099", "s.jsonl"), [
        { type: "turn_context", payload: { model: "gpt-5.6-sol" } },
        codexTokenCount({ input: 5000, cached: 4000, output: 500 }),
        // Context was compacted; the counter restarts rather than continuing.
        codexTokenCount({ input: 900, cached: 400, output: 90 }),
      ]);
    });

    const model = result.models.find((entry) => entry.model === "gpt-5.6-sol");
    expect(model?.tokens.outputTokens).toBe(590);
    expect(model?.tokens.cacheReadTokens).toBe(4400);
  });

  it("reports the Codex rate limit window", async () => {
    const result = await withFixture(async ({ codex }) => {
      await write(NodePath.join(codex, "2099", "s.jsonl"), [
        { type: "turn_context", payload: { model: "gpt-5.6-sol" } },
        codexTokenCount({ input: 100, cached: 0, output: 10 }),
      ]);
    });

    expect(result.rateLimits).toHaveLength(1);
    expect(result.rateLimits[0]?.planType).toBe("pro");
    expect(result.rateLimits[0]?.usedPercent).toBe(42);
    expect(result.rateLimits[0]?.windowMinutes).toBe(10080);
  });

  it("keeps tokens but not cost for a model with no pricing entry", async () => {
    const result = await withFixture(async ({ claude }) => {
      await write(NodePath.join(claude, "projects", "acme", "a.jsonl"), [
        claudeEntry({ id: "msg-1", model: "some-unreleased-model" }),
      ]);
    });

    const model = result.models.at(0);
    expect(model?.pricingKnown).toBe(false);
    expect(model?.tokens.outputTokens).toBe(50);
    expect(result.costUsd).toBe(0);
  });

  it("does not charge Codex fast rates when the log reports no premium tier", async () => {
    const result = await withFixture(async ({ codex }) => {
      await write(NodePath.join(codex, "2099", "s.jsonl"), [
        { type: "turn_context", payload: { model: "gpt-5.6-sol", service_tier: "default" } },
        codexTokenCount({ input: 1_000_000, cached: 0, output: 0 }),
      ]);
    });

    const pricing = lookupPricing("gpt-5.6-sol");
    expect(pricing?.fastMultiplier).toBe(2);
    // Standard tier bills the base rate, not the doubled fast rate.
    expect(result.costUsd).toBeCloseTo(pricing!.input, 6);
  });

  it("resolves a dated model slug to its family but not an unrelated slug", () => {
    expect(lookupPricing("claude-haiku-4-5-20251001")).toEqual(lookupPricing("claude-haiku-4-5"));
    // `gpt-5000` starts with `gpt-5` but is a different model, not a variant.
    expect(lookupPricing("gpt-5000-turbo")).toBeUndefined();
  });

  it("returns empty totals when neither agent has logs on this host", async () => {
    const result = await withFixture(async () => {});

    expect(result.costUsd).toBe(0);
    expect(result.models).toHaveLength(0);
    expect(result.sources.every((source) => !source.available)).toBe(true);
  });
});
