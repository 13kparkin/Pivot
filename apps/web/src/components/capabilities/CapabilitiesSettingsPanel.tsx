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
import { LoaderIcon, PlusIcon, SaveIcon, SearchIcon, Undo2Icon } from "lucide-react";
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
  filterSettingRows,
  isValidSettingKey,
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
 * ladder, and edit or reset individual settings. With a project targeted
 * (`projectKey`) the entries are the project's own config layer and writes
 * are locked to the project scope.
 */
export function CapabilitiesSettingsPanel({ projectKey = null }: { projectKey?: string | null }) {
  const environmentId = useActiveEnvironmentId();
  const groups = useSettingsProjectGroups();
  const projectId = resolveCapabilitiesProjectId(groups, environmentId, projectKey);
  const projectLocked = projectKey !== null;
  const [scope, setScope] = useState<OmpCapabilityScope>(projectLocked ? "project" : "global");
  const [query, setQuery] = useState("");
  // Project-scoped adds: a new key is written straight into the project
  // layer — the list only shows keys the project already overrides.
  const [addingSetting, setAddingSetting] = useState(false);
  const [newSettingKey, setNewSettingKey] = useState("");
  const [newSettingValue, setNewSettingValue] = useState("");
  const [addingBusy, setAddingBusy] = useState(false);
  const writeSetting = useAtomCommand(serverEnvironment.capabilitiesWriteSetting, {
    label: "capabilities-write-setting",
  });
  const addProjectSetting = async () => {
    const key = newSettingKey.trim();
    if (environmentId === null || !isValidSettingKey(key) || projectId === null) return;
    setAddingBusy(true);
    const result = await writeSetting({
      environmentId,
      input: buildWriteSettingInput({ key, value: newSettingValue, scope: "project", projectId }),
    });
    setAddingBusy(false);
    if (result._tag === "Failure") {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not add ${key}`,
          description: "Check that omp is installed on the server host and try again.",
        }),
      );
      return;
    }
    toastManager.add({ type: "success", title: `Added ${key}` });
    setNewSettingKey("");
    setNewSettingValue("");
    setAddingSetting(false);
    refreshSnapshot();
  };

  // Project scope is only available when the active environment has a project;
  // a targeted project view is always locked to the project scope.
  const effectiveScope: OmpCapabilityScope = projectLocked
    ? "project"
    : scope === "project" && projectId === null
      ? "global"
      : scope;

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

  const rows = filterSettingRows(buildSettingRows(snapshot.settings.entries), query);

  return (
    <SettingsPageContainer>
      <SettingsSection title="Settings">
        <SettingsRow
          title="Scope"
          description="Where writes and resets apply. Project-scoped writes need an active project."
          control={
            <Select
              value={effectiveScope}
              disabled={projectLocked}
              onValueChange={(value) => {
                if (projectLocked) return;
                if (value === "global" || value === "project") setScope(value);
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="Capabilities scope">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {projectLocked ? null : (
                  <SelectItem hideIndicator value="global">
                    Global
                  </SelectItem>
                )}
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
        <div className="flex items-center justify-between gap-3">
          <div className="relative max-w-72 flex-1">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/70" />
            <Input
              size="sm"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="Search settings"
              aria-label="Search settings"
              className="h-8 pl-8"
            />
          </div>
          {projectLocked ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 shrink-0 px-2.5 text-xs"
              onClick={() => setAddingSetting((open) => !open)}
            >
              <PlusIcon className="size-3.5" />
              Add setting
            </Button>
          ) : null}
        </div>
        {addingSetting && projectLocked ? (
          <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border/70 p-3">
            <label className="flex min-w-40 flex-1 flex-col gap-1 text-xs text-muted-foreground">
              Key
              <Input
                size="sm"
                className="h-8 font-mono"
                value={newSettingKey}
                onChange={(event) => setNewSettingKey(event.currentTarget.value)}
                placeholder="modelRoles.default"
                aria-label="New setting key"
                autoFocus
              />
            </label>
            <label className="flex min-w-40 flex-1 flex-col gap-1 text-xs text-muted-foreground">
              Value
              <Input
                size="sm"
                className="h-8 font-mono"
                value={newSettingValue}
                onChange={(event) => setNewSettingValue(event.currentTarget.value)}
                placeholder="gpt-5.6"
                aria-label="New setting value"
              />
            </label>
            <Button
              type="button"
              size="sm"
              className="h-8 px-2.5 text-xs"
              disabled={
                addingBusy || !isValidSettingKey(newSettingKey.trim()) || projectId === null
              }
              onClick={() => void addProjectSetting()}
            >
              {addingBusy ? (
                <LoaderIcon className="size-3.5 animate-spin" />
              ) : (
                <PlusIcon className="size-3.5" />
              )}
              Add
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8 px-2.5 text-xs text-muted-foreground"
              disabled={addingBusy}
              onClick={() => setAddingSetting(false)}
            >
              Cancel
            </Button>
          </div>
        ) : null}
        {rows.length === 0 ? (
          query.trim().length > 0 ? (
            <SettingsRow
              title="No matching settings"
              description="No settings match the current search."
            />
          ) : projectLocked ? (
            <div className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-foreground">No project settings yet</span>
              <span className="text-muted-foreground">
                Add the first project-level setting — it lands in this project's .omp config.
              </span>
            </div>
          ) : (
            <SettingsRow title="No settings" description="omp reported no config settings." />
          )
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
