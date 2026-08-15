"use client";

import { useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import {
  BookOpenIcon,
  LoaderIcon,
  ScrollTextIcon,
  Settings2Icon,
  type LucideIcon,
} from "lucide-react";

import { useActiveEnvironmentId } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useSettingsProjectGroups } from "../settings/ProjectSettingsPanel";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settings/settingsLayout";

import {
  buildCapabilityRows,
  buildProjectCapabilitiesOverviewCards,
  resolveCapabilitiesProjectId,
  type CapabilitiesOverviewCardTarget,
} from "./CapabilitiesOverviewPanel.logic";

const EMPTY_OVERVIEW_SNAPSHOT_ATOM = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel("web-capabilities:snapshot:overview:empty"),
);

/** Card icons match the sidebar section icons for the same destinations. */
const OVERVIEW_CARD_ICONS: Readonly<Record<CapabilitiesOverviewCardTarget, LucideIcon>> = {
  "/capabilities/settings": Settings2Icon,
  "/capabilities/skills": BookOpenIcon,
  "/capabilities/rules": ScrollTextIcon,
};

/**
 * High-level omp capability surface for the active environment: agent dir,
 * settings count, and the discovered capability resources with their
 * scope/provenance/status. When a project is targeted (projectKey), the
 * page becomes a launcher into the project-scoped sections instead.
 */
export function CapabilitiesOverviewPanel({ projectKey = null }: { projectKey?: string | null }) {
  const navigate = useNavigate();
  const environmentId = useActiveEnvironmentId();
  const groups = useSettingsProjectGroups();
  const projectId = resolveCapabilitiesProjectId(groups, environmentId, projectKey);
  const result = useAtomValue(
    environmentId === null
      ? EMPTY_OVERVIEW_SNAPSHOT_ATOM
      : serverEnvironment.capabilitiesSnapshot({
          environmentId,
          input: projectId === null ? {} : { projectId },
        }),
  );
  const snapshot = Option.getOrNull(AsyncResult.value(result))?.snapshot ?? null;

  if (environmentId === null) {
    return (
      <SettingsPageContainer>
        <p className="text-sm text-muted-foreground">
          Connect an environment to inspect its omp capabilities.
        </p>
      </SettingsPageContainer>
    );
  }

  if (snapshot === null) {
    if (result.waiting) {
      return (
        <SettingsPageContainer>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderIcon className="size-4 animate-spin" />
            Loading capabilities…
          </div>
        </SettingsPageContainer>
      );
    }
    return (
      <SettingsPageContainer>
        <div className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-foreground">Could not load omp capabilities</span>
          <span className="text-muted-foreground">
            Check that omp is installed on the server host and try again.
          </span>
        </div>
      </SettingsPageContainer>
    );
  }

  const rows = buildCapabilityRows(snapshot.resources);

  // Project-scoped overview: a card launcher into the project-only sections,
  // carrying the projectKey search param so each section stays project-scoped.
  if (projectKey !== null) {
    const cards = buildProjectCapabilitiesOverviewCards(snapshot);
    return (
      <SettingsPageContainer>
        <SettingsSection title="Capabilities">
          <div className="grid gap-3 sm:grid-cols-3">
            {cards.map((card) => {
              const Icon = OVERVIEW_CARD_ICONS[card.to];
              return (
                <button
                  key={card.to}
                  type="button"
                  onClick={() => void navigate({ to: card.to, search: { projectKey } })}
                  className="flex cursor-pointer flex-col items-start gap-1.5 rounded-xl border border-border/70 bg-card/60 p-4 text-left outline-none transition-colors hover:bg-accent/10 focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="flex w-full items-center justify-between">
                    <Icon className="size-4 text-muted-foreground" />
                    <span className="text-xs font-medium text-muted-foreground">{card.count}</span>
                  </span>
                  <span className="mt-1 text-sm font-medium text-foreground">{card.label}</span>
                  <span className="text-xs leading-relaxed text-muted-foreground">
                    {card.description}
                  </span>
                </button>
              );
            })}
          </div>
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer>
      <SettingsSection title="Capabilities">
        {snapshot.agentDirLabel !== undefined ? (
          <SettingsRow title="Agent directory" description={snapshot.agentDirLabel} />
        ) : null}
        <SettingsRow
          title="Settings"
          description={`${snapshot.settings.entries.length} omp config settings are available to edit.`}
        />
      </SettingsSection>
      <SettingsSection title="Resources">
        {rows.length === 0 ? (
          <SettingsRow title="No resources" description="omp reported no capability resources." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-xs">
              <thead className="border-b border-border/60 text-[11px] uppercase tracking-[0.08em] text-muted-foreground/70">
                <tr>
                  <th className="px-4 py-2 font-semibold sm:pl-5">Name</th>
                  <th className="px-3 py-2 font-semibold">Scope</th>
                  <th className="px-3 py-2 font-semibold">Provenance</th>
                  <th className="px-3 py-2 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {rows.map((row) => (
                  <tr key={`${row.resource.scope}:${row.resource.kind}:${row.resource.name}`}>
                    <td className="px-4 py-2 font-medium text-foreground sm:pl-5">{row.label}</td>
                    <td className="px-3 py-2 text-muted-foreground">{row.scopeLabel}</td>
                    <td className="px-3 py-2 text-muted-foreground">{row.provenanceLabel}</td>
                    <td className="px-3 py-2 text-muted-foreground">{row.statusLabel}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
