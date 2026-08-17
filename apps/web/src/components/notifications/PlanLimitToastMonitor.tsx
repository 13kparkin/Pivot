"use client";

import { useEffect, useMemo, useRef } from "react";

import { usePrimarySettings } from "~/hooks/useSettings";
import { useUsage } from "~/state/usage";
import { makeWindow } from "@t3tools/shared/usageFormat";
import { toastManager } from "../ui/toast";
import {
  findPlanLimitTransitions,
  type PlanLimitToast,
  type PlanLimitToastStates,
} from "./planLimitToastMonitor.logic";

const PROVIDER_LABEL: Record<string, string> = {
  "openai-codex": "Codex",
  "opencode-go": "OpenCode Go",
  cursor: "Cursor",
  anthropic: "Anthropic",
};

function planLimitToastTitle(status: "warning" | "exhausted"): string {
  return status === "exhausted" ? "Plan limit exhausted" : "Plan limit warning";
}

function planLimitToastDescription(toast: PlanLimitToast): string {
  const provider = PROVIDER_LABEL[toast.provider] ?? toast.provider;
  const state =
    toast.status === "exhausted" ? "is exhausted — requests may be blocked" : "is almost exhausted";
  return `${provider} · ${toast.label} ${state}.`;
}

/**
 * Fires a toast when a plan/quota window (Codex, Go, Cursor, …) transitions
 * into warning or exhausted, and again after it resets and re-warns. Renders
 * nothing. Gated by the "plan limit warnings" notification toggle.
 */
export function PlanLimitToastMonitor() {
  const notificationSettings = usePrimarySettings((settings) => settings.notificationSettings);
  // A one-day window is the lightest scan; plan limits are window-independent.
  const input = useMemo(() => makeWindow(1), []);
  const { merged } = useUsage(input);
  // Module-persisted across unmounts would survive settings changes worse than
  // this: previous states live for the app session, like the failure memory.
  const previousStates = useRef<PlanLimitToastStates>(new Map());

  useEffect(() => {
    if (!notificationSettings.planLimitWarnings) {
      return;
    }
    const { toasts, next } = findPlanLimitTransitions(previousStates.current, merged.planProviders);
    previousStates.current = next;
    for (const toast of toasts) {
      toastManager.add({
        type: toast.status === "exhausted" ? "error" : "warning",
        title: planLimitToastTitle(toast.status),
        description: planLimitToastDescription(toast),
      });
    }
  }, [merged.planProviders, notificationSettings.planLimitWarnings]);

  return null;
}
