/**
 * Live omp plan/quota reports (`omp usage --json`).
 *
 * Distinct from transcript token history: this is subscription capacity
 * (used/remaining/reset) for authenticated upstream providers such as
 * openai-codex and cursor.
 *
 * @module ompPlanUsage
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import type { UsagePlanLimit, UsagePlanProvider } from "@t3tools/contracts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

export interface OmpUsageJsonReport {
  readonly provider?: unknown;
  readonly limits?: unknown;
  readonly metadata?: unknown;
}

export interface OmpUsageJsonDocument {
  readonly reports?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Maps one omp usage report into the wire shape. */
export function mapOmpUsageReport(raw: unknown): UsagePlanProvider | null {
  const report = asRecord(raw);
  if (report === null) return null;
  const provider = asString(report["provider"]);
  if (provider === undefined) return null;

  const metadata = asRecord(report["metadata"]);
  const planType = metadata === null ? undefined : asString(metadata["planType"]);

  const limitsRaw = report["limits"];
  if (!Array.isArray(limitsRaw)) {
    return { provider, ...(planType !== undefined ? { planType } : {}), limits: [] };
  }

  const limits: UsagePlanLimit[] = [];
  for (const entry of limitsRaw) {
    const limit = asRecord(entry);
    if (limit === null) continue;
    const id = asString(limit["id"]);
    const label = asString(limit["label"]);
    if (id === undefined || label === undefined) continue;

    const window = asRecord(limit["window"]);
    const windowLabel = window === null ? label : (asString(window["label"]) ?? label);
    const resetsAtMs = window === null ? undefined : asFiniteNumber(window["resetsAt"]);

    const amount = asRecord(limit["amount"]);
    if (amount === null) continue;
    const used = asFiniteNumber(amount["used"]);
    if (used === undefined) continue;
    const unit = asString(amount["unit"]) ?? "percent";
    const status = asString(limit["status"]) ?? "ok";

    limits.push({
      id,
      label,
      windowLabel,
      ...(resetsAtMs !== undefined ? { resetsAtMs } : {}),
      used,
      ...(asFiniteNumber(amount["limit"]) !== undefined
        ? { limit: asFiniteNumber(amount["limit"]) }
        : {}),
      ...(asFiniteNumber(amount["remaining"]) !== undefined
        ? { remaining: asFiniteNumber(amount["remaining"]) }
        : {}),
      ...(asFiniteNumber(amount["usedFraction"]) !== undefined
        ? { usedFraction: asFiniteNumber(amount["usedFraction"]) }
        : {}),
      ...(asFiniteNumber(amount["remainingFraction"]) !== undefined
        ? { remainingFraction: asFiniteNumber(amount["remainingFraction"]) }
        : {}),
      unit,
      status,
    });
  }

  return {
    provider,
    ...(planType !== undefined ? { planType } : {}),
    limits,
  };
}

/** Parses the stdout of `omp usage --json`. */
export function parseOmpUsageJson(stdout: string): readonly UsagePlanProvider[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  const document = asRecord(parsed);
  if (document === null) return [];
  const reports = document["reports"];
  if (!Array.isArray(reports)) return [];

  const out: UsagePlanProvider[] = [];
  for (const report of reports) {
    const mapped = mapOmpUsageReport(report);
    if (mapped !== null) out.push(mapped);
  }
  return out;
}

export interface FetchOmpPlanUsageOptions {
  readonly binaryPath: string;
  readonly ompHome?: string;
  readonly timeoutMs?: number;
}

/**
 * Runs `omp usage --json` and returns plan providers. Failures yield an empty
 * list so transcript history still loads.
 */
export async function fetchOmpPlanUsage(
  options: FetchOmpPlanUsageOptions,
): Promise<readonly UsagePlanProvider[]> {
  const binaryPath = options.binaryPath.trim() || "omp";
  const ompHome =
    options.ompHome?.trim() ||
    process.env.OMP_HOME?.trim() ||
    NodePath.join(NodeOS.homedir(), ".omp");
  const timeoutMs = options.timeoutMs ?? 20_000;

  try {
    const { stdout } = await execFile(binaryPath, ["usage", "--json"], {
      env: { ...process.env, OMP_HOME: ompHome },
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
    return parseOmpUsageJson(stdout);
  } catch {
    return [];
  }
}
