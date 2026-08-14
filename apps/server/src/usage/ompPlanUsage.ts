/**
 * Live omp plan/quota reports (`omp usage --json`).
 *
 * Distinct from transcript token history: this is subscription capacity
 * (used/remaining/reset) for authenticated upstream providers such as
 * openai-codex and cursor.
 *
 * @module ompPlanUsage
 */
import * as NodeOS from "node:os";

import type { UsagePlanLimit, UsagePlanProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

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
export function mapOmpUsageReport(report: unknown): UsagePlanProvider | null {
  const row = asRecord(report);
  if (row === null) return null;
  const provider = asString(row.provider);
  if (provider === undefined) return null;

  const limitsRaw = Array.isArray(row.limits) ? row.limits : [];
  const limits: UsagePlanLimit[] = [];
  for (const entry of limitsRaw) {
    const limit = asRecord(entry);
    if (limit === null) continue;
    const id = asString(limit.id);
    const label = asString(limit.label);
    const status = asString(limit.status);
    if (id === undefined || label === undefined || status === undefined) continue;

    const window = asRecord(limit.window);
    const windowLabel = asString(window?.label) ?? label;
    const amount = asRecord(limit.amount);
    const used = asFiniteNumber(amount?.used);
    if (used === undefined) continue;

    const resetsAtMs = asFiniteNumber(window?.resetsAt);
    limits.push({
      id,
      label,
      windowLabel,
      used,
      unit: asString(amount?.unit) ?? "percent",
      status,
      ...(asFiniteNumber(amount?.limit) !== undefined
        ? { limit: asFiniteNumber(amount?.limit) }
        : {}),
      ...(asFiniteNumber(amount?.remaining) !== undefined
        ? { remaining: asFiniteNumber(amount?.remaining) }
        : {}),
      ...(asFiniteNumber(amount?.usedFraction) !== undefined
        ? { usedFraction: asFiniteNumber(amount?.usedFraction) }
        : {}),
      ...(asFiniteNumber(amount?.remainingFraction) !== undefined
        ? { remainingFraction: asFiniteNumber(amount?.remainingFraction) }
        : {}),
      ...(resetsAtMs !== undefined ? { resetsAtMs } : {}),
    });
  }

  const metadata = asRecord(row.metadata);
  const planType = metadata !== null ? asString(metadata.planType) : undefined;
  return {
    provider,
    limits,
    ...(planType !== undefined ? { planType } : {}),
  };
}

/** Parses the stdout of `omp usage --json`. */
export function parseOmpUsageJson(stdout: string): readonly UsagePlanProvider[] {
  let document: unknown;
  try {
    document = JSON.parse(stdout) as unknown;
  } catch {
    return [];
  }
  const root = asRecord(document);
  const reports = root !== null && Array.isArray(root.reports) ? root.reports : [];
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
}

/**
 * Runs `omp usage --json` and returns plan providers. Failures yield an empty
 * list so transcript history still loads.
 */
export function fetchOmpPlanUsage(
  options: FetchOmpPlanUsageOptions,
): Effect.Effect<readonly UsagePlanProvider[], never, ChildProcessSpawner.ChildProcessSpawner> {
  const binaryPath = options.binaryPath.trim() || "omp";
  const ompHome =
    options.ompHome?.trim() || process.env.OMP_HOME?.trim() || `${NodeOS.homedir()}/.omp`;

  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner
      .spawn(
        ChildProcess.make(binaryPath, ["usage", "--json"], {
          shell: false,
          env: { ...process.env, OMP_HOME: ompHome },
          stdout: "pipe",
          stderr: "ignore",
        }),
      )
      .pipe(Effect.orElseSucceed(() => null));
    if (!child) {
      return [];
    }
    const [output, exitCode] = yield* Effect.all(
      [
        child.stdout.pipe(
          Stream.decodeText(),
          Stream.runFold(
            () => "",
            (acc, chunk) => acc + chunk,
          ),
          Effect.orElseSucceed(() => ""),
        ),
        child.exitCode.pipe(
          Effect.map(Number),
          Effect.orElseSucceed(() => 1),
        ),
      ],
      { concurrency: "unbounded" },
    );
    if (exitCode !== 0 || output.trim().length === 0) {
      return [];
    }
    return parseOmpUsageJson(output);
  }).pipe(
    Effect.scoped,
    Effect.orElseSucceed(() => [] as const),
  );
}
