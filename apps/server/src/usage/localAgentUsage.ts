// Streams large append-only JSONL logs line by line. Effect's FileSystem has no
// streaming line reader, and these files run to hundreds of megabytes, so the
// node primitives are used directly here.
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import type {
  UsageDailyTotals,
  UsageModelTotals,
  UsageProjectTotals,
  UsageProvider,
  UsageRateLimitWindow,
  UsageSourceReport,
  UsageTokenTotals,
} from "@t3tools/contracts";

import { calculateCostUsd, lookupPricing } from "./pricing.ts";

/**
 * Reads the JSONL session logs Claude Code and Codex write locally and turns
 * them into billable totals.
 *
 * Two details carry most of the correctness weight:
 *
 * 1. Claude duplicates records across files when a session is resumed or
 *    forked, so entries are deduped on message id. Skipping that step
 *    overcounts by roughly 2.7x on a busy machine.
 * 2. Codex reports cumulative totals per session, so per-turn deltas come from
 *    subtracting the previous snapshot. A snapshot that moves backwards means
 *    the context was compacted, and the current value is the delta.
 */

export type LocalUsageOptions = {
  /** Inclusive lower bound, YYYY-MM-DD. Entries older than this are ignored. */
  readonly sinceDate?: string;
  readonly homeDir?: string;
  /** Overrides for tests; defaults derive from the home directory. */
  readonly claudeDirs?: ReadonlyArray<string>;
  readonly codexDir?: string;
};

type MutableTokens = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
};

type Bucket = MutableTokens & { costUsd: number; messages: number };

export type LocalUsageResult = {
  readonly costUsd: number;
  readonly tokens: UsageTokenTotals;
  readonly messages: number;
  readonly sessions: number;
  readonly models: ReadonlyArray<UsageModelTotals>;
  readonly daily: ReadonlyArray<UsageDailyTotals>;
  readonly projects: ReadonlyArray<UsageProjectTotals>;
  readonly rateLimits: ReadonlyArray<UsageRateLimitWindow>;
  readonly sources: ReadonlyArray<UsageSourceReport>;
  readonly firstDate: string | undefined;
  readonly lastDate: string | undefined;
};

const emptyBucket = (): Bucket => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  costUsd: 0,
  messages: 0,
});

const addTokens = (target: Bucket, delta: MutableTokens, costUsd: number): void => {
  target.inputTokens += delta.inputTokens;
  target.outputTokens += delta.outputTokens;
  target.cacheReadTokens += delta.cacheReadTokens;
  target.cacheWriteTokens += delta.cacheWriteTokens;
  target.reasoningTokens += delta.reasoningTokens;
  target.costUsd += costUsd;
  target.messages += 1;
};

const toInt = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;

const dayOf = (timestamp: unknown): string | undefined =>
  typeof timestamp === "string" && timestamp.length >= 10 ? timestamp.slice(0, 10) : undefined;

async function collectJsonlFiles(root: string): Promise<Array<string>> {
  const found: Array<string> = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await NodeFSP.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".jsonl")) found.push(path);
    }
  };
  await walk(root);
  return found;
}

async function* readJsonLines(path: string): AsyncGenerator<Record<string, unknown>> {
  const stream = NodeFS.createReadStream(path, { encoding: "utf8" });
  try {
    const lines = NodeReadline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      if (line.length === 0) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (parsed !== null && typeof parsed === "object") {
          yield parsed as Record<string, unknown>;
        }
      } catch {
        // Session logs are append-only; a torn final line is expected while an
        // agent is mid-write and is not worth failing the whole scan over.
      }
    }
  } finally {
    stream.destroy();
  }
}

/**
 * A file whose newest write predates the cutoff cannot contain in-range
 * entries, so it is skipped without being opened.
 */
async function isStale(path: string, sinceDate: string | undefined): Promise<boolean> {
  if (sinceDate === undefined) return false;
  try {
    const info = await NodeFSP.stat(path);
    // One day of slack: mtime is UTC while sinceDate is a calendar day, and a
    // boundary file must never be dropped just because the two disagree.
    const cutoff = new Date(`${sinceDate}T00:00:00.000Z`);
    cutoff.setUTCDate(cutoff.getUTCDate() - 1);
    return info.mtime < cutoff;
  } catch {
    return false;
  }
}

type Accumulator = {
  readonly byModel: Map<string, Bucket & { provider: UsageProvider; pricingKnown: boolean }>;
  readonly byDayProvider: Map<string, Bucket & { provider: UsageProvider }>;
  readonly byProject: Map<string, Bucket>;
  readonly unpriced: Set<string>;
  dates: Array<string>;
};

const newAccumulator = (): Accumulator => ({
  byModel: new Map(),
  byDayProvider: new Map(),
  byProject: new Map(),
  unpriced: new Set(),
  dates: [],
});

function record(
  acc: Accumulator,
  provider: UsageProvider,
  model: string,
  day: string | undefined,
  project: string,
  delta: MutableTokens,
  costUsd: number,
  pricingKnown: boolean,
): void {
  const modelKey = `${provider}:${model}`;
  let modelBucket = acc.byModel.get(modelKey);
  if (modelBucket === undefined) {
    modelBucket = { ...emptyBucket(), provider, pricingKnown };
    acc.byModel.set(modelKey, modelBucket);
  }
  modelBucket.pricingKnown = modelBucket.pricingKnown && pricingKnown;
  addTokens(modelBucket, delta, costUsd);

  if (day !== undefined) {
    const dayKey = `${day}:${provider}`;
    let dayBucket = acc.byDayProvider.get(dayKey);
    if (dayBucket === undefined) {
      dayBucket = { ...emptyBucket(), provider };
      acc.byDayProvider.set(dayKey, dayBucket);
    }
    addTokens(dayBucket, delta, costUsd);
    acc.dates.push(day);
  }

  let projectBucket = acc.byProject.get(project);
  if (projectBucket === undefined) {
    projectBucket = emptyBucket();
    acc.byProject.set(project, projectBucket);
  }
  addTokens(projectBucket, delta, costUsd);
}

const projectOf = (cwd: unknown): string => {
  if (typeof cwd !== "string" || cwd.length === 0) return "unknown";
  const parts = cwd.split(/[/\\]/).filter((part) => part.length > 0);
  return parts.at(-1) ?? "unknown";
};

async function scanClaude(
  acc: Accumulator,
  roots: ReadonlyArray<string>,
  sinceDate: string | undefined,
): Promise<{ report: UsageSourceReport; sessions: number }> {
  const files: Array<string> = [];
  for (const root of roots)
    files.push(...(await collectJsonlFiles(NodePath.join(root, "projects"))));

  const seen = new Set<string>();
  let recordsRead = 0;
  let duplicatesSkipped = 0;

  for (const file of files) {
    if (await isStale(file, sinceDate)) continue;
    for await (const entry of readJsonLines(file)) {
      if (entry["type"] !== "assistant") continue;
      const message = entry["message"];
      if (message === null || typeof message !== "object") continue;
      const messageRecord = message as Record<string, unknown>;
      const usage = messageRecord["usage"];
      if (usage === null || typeof usage !== "object") continue;
      recordsRead += 1;

      const day = dayOf(entry["timestamp"]);
      if (sinceDate !== undefined && day !== undefined && day < sinceDate) continue;

      const messageId = messageRecord["id"];
      if (typeof messageId === "string" && messageId.length > 0) {
        const key = `${messageId}:${String(entry["requestId"] ?? "")}`;
        if (seen.has(key)) {
          duplicatesSkipped += 1;
          continue;
        }
        seen.add(key);
      }

      const model = typeof messageRecord["model"] === "string" ? messageRecord["model"] : "unknown";
      if (model === "<synthetic>") continue;

      const usageRecord = usage as Record<string, unknown>;
      const cacheCreation = usageRecord["cache_creation"];
      const creationRecord =
        cacheCreation !== null && typeof cacheCreation === "object"
          ? (cacheCreation as Record<string, unknown>)
          : undefined;
      const write1h = toInt(creationRecord?.["ephemeral_1h_input_tokens"]);
      const write5m =
        creationRecord === undefined
          ? toInt(usageRecord["cache_creation_input_tokens"])
          : toInt(creationRecord["ephemeral_5m_input_tokens"]);

      const delta: MutableTokens = {
        inputTokens: toInt(usageRecord["input_tokens"]),
        outputTokens: toInt(usageRecord["output_tokens"]),
        cacheReadTokens: toInt(usageRecord["cache_read_input_tokens"]),
        cacheWriteTokens: write5m + write1h,
        reasoningTokens: 0,
      };

      const pricing = lookupPricing(model);
      if (pricing === undefined) acc.unpriced.add(model);
      const costUsd =
        pricing === undefined
          ? 0
          : calculateCostUsd(
              {
                inputTokens: delta.inputTokens,
                outputTokens: delta.outputTokens,
                cacheReadTokens: delta.cacheReadTokens,
                cacheWrite5mTokens: write5m,
                cacheWrite1hTokens: write1h,
                fast: usageRecord["speed"] === "fast",
              },
              pricing,
            );

      record(
        acc,
        "claude",
        model,
        day,
        projectOf(entry["cwd"]),
        delta,
        costUsd,
        pricing !== undefined,
      );
    }
  }

  return {
    report: {
      provider: "claude",
      available: files.length > 0,
      filesScanned: files.length,
      recordsRead,
      duplicatesSkipped,
      modelsWithoutPricing: [],
    },
    sessions: files.length,
  };
}

type CodexSnapshot = {
  input: number;
  cached: number;
  output: number;
  reasoning: number;
};

async function scanCodex(
  acc: Accumulator,
  root: string,
  sinceDate: string | undefined,
): Promise<{
  report: UsageSourceReport;
  sessions: number;
  rateLimits: Array<UsageRateLimitWindow>;
}> {
  const files = await collectJsonlFiles(root);
  let recordsRead = 0;
  let latest: UsageRateLimitWindow | undefined;

  for (const file of files) {
    if (await isStale(file, sinceDate)) continue;
    let previous: CodexSnapshot | undefined;
    let model = "unknown";
    let cwd: unknown;
    // Codex only writes a service tier when the turn ran on a premium tier.
    // Absent that marker the turn is standard, so cost is never inflated by
    // assuming the multiplier applies.
    let fast = false;

    for await (const entry of readJsonLines(file)) {
      const payload = entry["payload"];
      const payloadRecord =
        payload !== null && typeof payload === "object"
          ? (payload as Record<string, unknown>)
          : undefined;

      if (entry["type"] === "session_meta" || entry["type"] === "turn_context") {
        const candidate = payloadRecord?.["model"];
        if (typeof candidate === "string" && candidate.length > 0) model = candidate;
        const candidateCwd = payloadRecord?.["cwd"];
        if (typeof candidateCwd === "string") cwd = candidateCwd;
        const tier = payloadRecord?.["service_tier"];
        if (typeof tier === "string") fast = tier === "fast" || tier === "priority";
      }
      if (payloadRecord?.["type"] !== "token_count") continue;

      const info = payloadRecord["info"];
      if (info === null || typeof info !== "object") continue;
      const total = (info as Record<string, unknown>)["total_token_usage"];
      if (total === null || typeof total !== "object") continue;
      recordsRead += 1;

      const limits = payloadRecord["rate_limits"];
      if (limits !== null && typeof limits === "object") {
        const parsed = parseRateLimit(limits as Record<string, unknown>, entry["timestamp"]);
        if (
          parsed !== undefined &&
          (latest === undefined || parsed.observedAt > latest.observedAt)
        ) {
          latest = parsed;
        }
      }

      const totalRecord = total as Record<string, unknown>;
      const inputTokens = toInt(totalRecord["input_tokens"]);
      const current: CodexSnapshot = {
        input: inputTokens,
        // Bad data can report more cached than input; clamping keeps fresh input non-negative.
        cached: Math.min(toInt(totalRecord["cached_input_tokens"]), inputTokens),
        output: toInt(totalRecord["output_tokens"]),
        reasoning: toInt(totalRecord["reasoning_output_tokens"]),
      };

      const rewound =
        previous !== undefined &&
        (current.input < previous.input || current.output < previous.output);
      const base =
        rewound || previous === undefined
          ? { input: 0, cached: 0, output: 0, reasoning: 0 }
          : previous;
      const cachedDelta = Math.max(0, current.cached - base.cached);
      const inputDelta = Math.max(0, current.input - base.input);
      previous = current;
      if (inputDelta === 0 && current.output - base.output <= 0) continue;

      const day = dayOf(entry["timestamp"]);
      if (sinceDate !== undefined && day !== undefined && day < sinceDate) continue;

      const delta: MutableTokens = {
        // Codex counts cached inside input; the billable fresh portion is the remainder.
        inputTokens: Math.max(0, inputDelta - cachedDelta),
        outputTokens: Math.max(0, current.output - base.output),
        cacheReadTokens: cachedDelta,
        cacheWriteTokens: 0,
        reasoningTokens: Math.max(0, current.reasoning - base.reasoning),
      };

      const pricing = lookupPricing(model);
      if (pricing === undefined) acc.unpriced.add(model);
      const costUsd =
        pricing === undefined
          ? 0
          : calculateCostUsd(
              {
                inputTokens: delta.inputTokens,
                outputTokens: delta.outputTokens,
                cacheReadTokens: delta.cacheReadTokens,
                cacheWrite5mTokens: 0,
                cacheWrite1hTokens: 0,
                fast,
              },
              pricing,
            );

      record(acc, "codex", model, day, projectOf(cwd), delta, costUsd, pricing !== undefined);
    }
  }

  return {
    report: {
      provider: "codex",
      available: files.length > 0,
      filesScanned: files.length,
      recordsRead,
      duplicatesSkipped: 0,
      modelsWithoutPricing: [],
    },
    sessions: files.length,
    rateLimits: latest === undefined ? [] : [latest],
  };
}

function parseRateLimit(
  limits: Record<string, unknown>,
  timestamp: unknown,
): UsageRateLimitWindow | undefined {
  const primary = limits["primary"];
  if (primary === null || typeof primary !== "object") return undefined;
  const primaryRecord = primary as Record<string, unknown>;
  const usedPercent = primaryRecord["used_percent"];
  if (typeof usedPercent !== "number") return undefined;
  const resetsAt = primaryRecord["resets_at"];
  const planType = limits["plan_type"];
  return {
    provider: "codex",
    planType: typeof planType === "string" && planType.length > 0 ? planType : undefined,
    usedPercent,
    windowMinutes: toInt(primaryRecord["window_minutes"]),
    resetsAt: typeof resetsAt === "number" ? new Date(resetsAt * 1000).toISOString() : undefined,
    observedAt: typeof timestamp === "string" ? timestamp : new Date(0).toISOString(),
  };
}

export async function readLocalAgentUsage(
  options: LocalUsageOptions = {},
): Promise<LocalUsageResult> {
  const home = options.homeDir ?? NodeOS.homedir();
  const claudeDirs = options.claudeDirs ?? [NodePath.join(home, ".claude")];
  const codexDir = options.codexDir ?? NodePath.join(home, ".codex", "sessions");
  const acc = newAccumulator();

  const [claude, codex] = await Promise.all([
    scanClaude(acc, claudeDirs, options.sinceDate),
    scanCodex(acc, codexDir, options.sinceDate),
  ]);

  const unpricedList = [...acc.unpriced].sort();
  const sources: Array<UsageSourceReport> = [
    { ...claude.report, modelsWithoutPricing: unpricedList },
    { ...codex.report, modelsWithoutPricing: unpricedList },
  ];

  const models: Array<UsageModelTotals> = [...acc.byModel.entries()]
    .map(([key, bucket]) => ({
      model: key.slice(key.indexOf(":") + 1),
      provider: bucket.provider,
      tokens: {
        inputTokens: bucket.inputTokens,
        outputTokens: bucket.outputTokens,
        cacheReadTokens: bucket.cacheReadTokens,
        cacheWriteTokens: bucket.cacheWriteTokens,
        reasoningTokens: bucket.reasoningTokens,
      },
      costUsd: bucket.costUsd,
      messages: bucket.messages,
      pricingKnown: bucket.pricingKnown,
    }))
    .sort((a, b) => b.costUsd - a.costUsd || b.messages - a.messages);

  const dailyByDate = new Map<
    string,
    Array<{ provider: UsageProvider; costUsd: number; totalTokens: number }>
  >();
  for (const [key, bucket] of acc.byDayProvider) {
    const date = key.slice(0, key.indexOf(":"));
    const totalTokens =
      bucket.inputTokens + bucket.outputTokens + bucket.cacheReadTokens + bucket.cacheWriteTokens;
    const list = dailyByDate.get(date) ?? [];
    list.push({ provider: bucket.provider, costUsd: bucket.costUsd, totalTokens });
    dailyByDate.set(date, list);
  }
  const daily: Array<UsageDailyTotals> = [...dailyByDate.entries()]
    .map(([date, byProvider]) => ({
      date,
      costUsd: byProvider.reduce((sum, item) => sum + item.costUsd, 0),
      totalTokens: byProvider.reduce((sum, item) => sum + item.totalTokens, 0),
      byProvider: byProvider.sort((a, b) => a.provider.localeCompare(b.provider)),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const projects: Array<UsageProjectTotals> = [...acc.byProject.entries()]
    .map(([project, bucket]) => ({
      project,
      costUsd: bucket.costUsd,
      totalTokens:
        bucket.inputTokens + bucket.outputTokens + bucket.cacheReadTokens + bucket.cacheWriteTokens,
      messages: bucket.messages,
    }))
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, 20);

  const totals = models.reduce(
    (sum, model) => ({
      inputTokens: sum.inputTokens + model.tokens.inputTokens,
      outputTokens: sum.outputTokens + model.tokens.outputTokens,
      cacheReadTokens: sum.cacheReadTokens + model.tokens.cacheReadTokens,
      cacheWriteTokens: sum.cacheWriteTokens + model.tokens.cacheWriteTokens,
      reasoningTokens: sum.reasoningTokens + model.tokens.reasoningTokens,
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    },
  );

  const sortedDates = acc.dates.sort();
  return {
    costUsd: models.reduce((sum, model) => sum + model.costUsd, 0),
    tokens: totals,
    messages: models.reduce((sum, model) => sum + model.messages, 0),
    sessions: claude.sessions + codex.sessions,
    models,
    daily,
    projects,
    rateLimits: codex.rateLimits,
    sources,
    firstDate: sortedDates.at(0),
    lastDate: sortedDates.at(-1),
  };
}
