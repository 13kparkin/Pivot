"use client";

import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { LoaderIcon } from "lucide-react";

import { useActiveEnvironmentId } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useSettingsProjectGroups } from "../settings/ProjectSettingsPanel";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settings/settingsLayout";

import {
  buildCapabilityRows,
  resolveCapabilitiesProjectId,
} from "./CapabilitiesOverviewPanel.logic";

const EMPTY_OVERVIEW_SNAPSHOT_ATOM = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel("web-capabilities:snapshot:overview:empty"),
);

/**
 * High-level omp capability surface for the active environment: agent dir,
 * settings count, and the discovered capability resources with their
 * scope/provenance/status.
 */
export function CapabilitiesOverviewPanel({ projectKey = null }: { projectKey?: string | null }) {
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
