import { assert, describe, it } from "vite-plus/test";
import type { UsagePlanLimit, UsagePlanProvider } from "@t3tools/contracts";

import { findPlanLimitTransitions, type PlanLimitToastStates } from "./planLimitToastMonitor.logic";

function limit(overrides: Partial<UsagePlanLimit> & { id: string }): UsagePlanLimit {
  return {
    label: overrides.id,
    windowLabel: "Monthly",
    used: 0,
    unit: "percent",
    status: "ok",
    ...overrides,
  };
}

function provider(name: string, limits: readonly UsagePlanLimit[]): UsagePlanProvider {
  return { provider: name, limits };
}

function states(
  entries: ReadonlyArray<[string, string, number | undefined]>,
): PlanLimitToastStates {
  return new Map(entries.map(([key, status, resetsAtMs]) => [key, { status, resetsAtMs }]));
}

const GO = "opencode-go";
const KEY = `${GO}:Monthly:go-monthly`;

describe("findPlanLimitTransitions", () => {
  it("toasts when a limit enters warning", () => {
    const { toasts } = findPlanLimitTransitions(states([[KEY, "ok", 100]]), [
      provider(GO, [limit({ id: "go-monthly", status: "warning", usedFraction: 0.85 })]),
    ]);
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0]?.status, "warning");
    assert.equal(toasts[0]?.label, "go-monthly");
  });

  it("stays quiet while a limit remains in the same state", () => {
    const { toasts } = findPlanLimitTransitions(states([[KEY, "exhausted", 100]]), [
      provider(GO, [limit({ id: "go-monthly", status: "exhausted", usedFraction: 1 })]),
    ]);
    assert.deepEqual(toasts, []);
  });

  it("toasts when a warning escalates to exhausted", () => {
    const { toasts } = findPlanLimitTransitions(states([[KEY, "warning", 100]]), [
      provider(GO, [limit({ id: "go-monthly", status: "exhausted", usedFraction: 1 })]),
    ]);
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0]?.status, "exhausted");
  });

  it("is quiet on recovery back to ok", () => {
    const { toasts } = findPlanLimitTransitions(states([[KEY, "exhausted", 100]]), [
      provider(GO, [limit({ id: "go-monthly", status: "ok", usedFraction: 0.1 })]),
    ]);
    assert.deepEqual(toasts, []);
  });

  it("re-toasts the same state after the window resets", () => {
    const { toasts } = findPlanLimitTransitions(states([[KEY, "warning", 100]]), [
      provider(GO, [
        limit({ id: "go-monthly", status: "warning", usedFraction: 0.9, resetsAtMs: 200 }),
      ]),
    ]);
    assert.equal(toasts.length, 1);
  });

  it("toasts an unseen limit already in a warning state", () => {
    const { toasts } = findPlanLimitTransitions(states([]), [
      provider("openai-codex", [limit({ id: "codex-7d", status: "exhausted", usedFraction: 1 })]),
    ]);
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0]?.provider, "openai-codex");
  });

  it("records the next state map for persistence", () => {
    const { next } = findPlanLimitTransitions(states([]), [
      provider(GO, [
        limit({ id: "go-monthly", status: "warning", usedFraction: 0.9, resetsAtMs: 300 }),
      ]),
    ]);
    assert.equal(next.get(KEY)?.status, "warning");
    assert.equal(next.get(KEY)?.resetsAtMs, 300);
  });
});
