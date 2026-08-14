"use client";

import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  OmpCapabilityScope,
  OmpSettingsSurfaceEntry,
  ProjectId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { LoaderIcon, SaveIcon, Undo2Icon } from "lucide-react";
import { useState } from "react";

import { useActiveEnvironmentId } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSettingsProjectGroups } from "../settings/ProjectSettingsPanel";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";

import {
  buildPrecedenceLabel,
  buildSettingRows,
  buildWriteSettingInput,
  canEditEntry,
} from "./CapabilitiesSettingsPanel.logic";
import { resolveCapabilitiesProjectId } from "./CapabilitiesOverviewPanel.logic";

const EMPTY_SETTINGS_SNAPSHOT_ATOM = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel("web-capabilities:snapshot:settings:empty"),
);

export type CapabilitiesSettingsRow = OmpSettingsSurfaceEntry & { readonly displayValue: string };

function CapabilitiesSettingRow({
  entry,
  scope,
  environmentId,
  projectId,
  onMutated,
}: {
  entry: CapabilitiesSettingsRow;
  scope: OmpCapabilityScope;
  environmentId: EnvironmentId;
  projectId: ProjectId | null;
  onMutated: () => void;
}) {
  const [draft, setDraft] = useState(entry.masked ? "" : String(entry.value ?? ""));
  const [busy, setBusy] = useState<"save" | "reset" | null>(null);
  const writeSetting = useAtomCommand(serverEnvironment.capabilitiesWriteSetting, {
    label: "capabilities-write-setting",
  });
  const resetSetting = useAtomCommand(serverEnvironment.capabilitiesResetSetting, {
    label: "capabilities-reset-setting",
  });

  const save = async () => {
    setBusy("save");
    const result = await writeSetting({
      environmentId,
      input: buildWriteSettingInput({ key: entry.key, value: draft, scope, projectId }),
    });
    setBusy(null);
    if (result._tag === "Failure") {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not save ${entry.key}`,
          description: "Check that omp is installed on the server host and try again.",
        }),
      );
      return;
    }
    toastManager.add({ type: "success", title: `Saved ${entry.key}` });
    onMutated();
  };

  const reset = async () => {
    if (!window.confirm(`Reset ${entry.key} to its default?`)) return;
    setBusy("reset");
    const result = await resetSetting({
      environmentId,
      input: {
        key: entry.key,
        scope,
        confirm: true,
        ...(projectId === null ? {} : { projectId }),
      },
    });
    setBusy(null);
    if (result._tag === "Failure") {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not reset ${entry.key}`,
          description: "Check that omp is installed on the server host and try again.",
        }),
      );
      return;
    }
    toastManager.add({ type: "success", title: `Reset ${entry.key}` });
    onMutated();
  };

  const editable = canEditEntry(entry);
  const hasValue = entry.value !== undefined;

  return (
    <tr>
      <td className="px-4 py-2 font-mono font-medium text-foreground sm:pl-5">{entry.key}</td>
      <td className="px-3 py-2 text-muted-foreground">{entry.type}</td>
      <td className="max-w-56 px-3 py-2 text-muted-foreground">{entry.description}</td>
      <td className="px-3 py-2">
        {editable ? (
          <Input
            size="sm"
            className="h-7 min-w-40 font-mono text-xs"
            value={draft}
            onChange={(event) => setDraft(event.currentTarget.value)}
            placeholder="Unset"
            aria-label={`Value for ${entry.key}`}
          />
        ) : (
          <span className="font-mono text-muted-foreground">{entry.displayValue}</span>
        )}
      </td>
      <td className="px-3 py-2 text-right">
        {editable ? (
          <div className="inline-flex items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={busy !== null}
              onClick={() => void save()}
            >
              {busy === "save" ? (
                <LoaderIcon className="size-3.5 animate-spin" />
              ) : (
                <SaveIcon className="size-3.5" />
              )}
              Save
            </Button>
            {hasValue ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                disabled={busy !== null}
                onClick={() => void reset()}
              >
                <Undo2Icon className="size-3.5" />
                Reset
              </Button>
            ) : null}
          </div>
        ) : null}
      </td>
    </tr>
  );
}

/**
 * omp config settings surface: pick the write scope, see the precedence
 * ladder, and edit or reset individual settings.
 */
export function CapabilitiesSettingsPanel() {
  const environmentId = useActiveEnvironmentId();
  const groups = useSettingsProjectGroups();
  const projectId = resolveCapabilitiesProjectId(groups, environmentId);
  const [scope, setScope] = useState<OmpCapabilityScope>("global");

  // Project scope is only available when the active environment has a project.
  const effectiveScope: OmpCapabilityScope =
    scope === "project" && projectId === null ? "global" : scope;

  const snapshotAtom =
    environmentId === null
      ? EMPTY_SETTINGS_SNAPSHOT_ATOM
      : serverEnvironment.capabilitiesSnapshot({
          environmentId,
          input: projectId === null ? {} : { projectId },
        });
  const result = useAtomValue(snapshotAtom);
  const refreshSnapshot = useAtomRefresh(snapshotAtom);
  const snapshot = Option.getOrNull(AsyncResult.value(result))?.snapshot ?? null;

  if (environmentId === null) {
    return (
      <SettingsPageContainer>
        <p className="text-sm text-muted-foreground">
          Connect an environment to edit its omp settings.
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
            Loading settings…
          </div>
        </SettingsPageContainer>
      );
    }
    return (
      <SettingsPageContainer>
        <div className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-foreground">Could not load omp settings</span>
          <span className="text-muted-foreground">
            Check that omp is installed on the server host and try again.
          </span>
        </div>
      </SettingsPageContainer>
    );
  }

  const rows = buildSettingRows(snapshot.settings.entries);

  return (
    <SettingsPageContainer>
      <SettingsSection title="Settings">
        <SettingsRow
          title="Scope"
          description="Where writes and resets apply. Project-scoped writes need an active project."
          control={
            <Select
              value={effectiveScope}
              onValueChange={(value) => {
                if (value === "global" || value === "project") setScope(value);
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Capabilities scope">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="global">
                  Global
                </SelectItem>
                <SelectItem hideIndicator value="project" disabled={projectId === null}>
                  Project
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
        <SettingsRow title="Precedence" description={buildPrecedenceLabel(effectiveScope)} />
      </SettingsSection>
      <SettingsSection title="Entries">
        {rows.length === 0 ? (
          <SettingsRow title="No settings" description="omp reported no config settings." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-xs">
              <thead className="border-b border-border/60 text-[11px] uppercase tracking-[0.08em] text-muted-foreground/70">
                <tr>
                  <th className="px-4 py-2 font-semibold sm:pl-5">Key</th>
                  <th className="px-3 py-2 font-semibold">Type</th>
                  <th className="px-3 py-2 font-semibold">Description</th>
                  <th className="px-3 py-2 font-semibold">Value</th>
                  <th className="px-3 py-2 text-right font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {rows.map((row) => (
                  <CapabilitiesSettingRow
                    key={row.key}
                    entry={row}
                    scope={effectiveScope}
                    environmentId={environmentId}
                    projectId={projectId}
                    onMutated={refreshSnapshot}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
