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
import { LoaderIcon, MoveRightIcon, PlusIcon, SaveIcon, SearchIcon, Undo2Icon } from "lucide-react";
import { useState } from "react";

import { useActiveEnvironmentId } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSettingsProjectGroups } from "../settings/ProjectSettingsPanel";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { stackedThreadToast, toastManager } from "../ui/toast";

import {
  buildPrecedenceLabel,
  buildSettingRows,
  buildWriteSettingInput,
  canEditEntry,
  filterSettingRows,
  isValidSettingKey,
} from "./CapabilitiesSettingsPanel.logic";
import { resolveCapabilitiesProjectIdForView } from "./CapabilitiesOverviewPanel.logic";

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
  onMoveToProject,
  moving = false,
}: {
  entry: CapabilitiesSettingsRow;
  scope: OmpCapabilityScope;
  environmentId: EnvironmentId;
  projectId: ProjectId | null;
  onMutated: () => void;
  /** Project view: global-origin entries offer moving into the project. */
  onMoveToProject?: () => void;
  moving?: boolean;
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

  const projectView = onMoveToProject !== undefined;
  const isProjectEntry = entry.scope === "project";
  const editable = canEditEntry(entry) && (projectView ? isProjectEntry : true);
  const hasValue = entry.value !== undefined;

  return (
    <tr>
      <td className="px-4 py-2 sm:pl-5">
        <div className="flex items-center gap-2">
          <span className="font-mono font-medium text-foreground">{entry.key}</span>
          {projectView ? (
            <span
              className={`rounded-sm px-1.5 py-0.5 text-[10px] font-medium ${isProjectEntry ? "bg-accent/50 text-accent-foreground" : "bg-sidebar-row-hover text-muted-foreground"}`}
            >
              {isProjectEntry ? "Project" : "Global"}
            </span>
          ) : null}
        </div>
      </td>
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
      <td className="sticky right-0 z-10 bg-background py-2 pe-6 ps-5 text-right">
        {projectView && !isProjectEntry ? (
          <Button
            type="button"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={moving || !hasValue || !canEditEntry(entry)}
            onClick={onMoveToProject}
          >
            {moving ? (
              <LoaderIcon className="size-3.5 animate-spin" />
            ) : (
              <MoveRightIcon className="size-3.5" />
            )}
            Move to project
          </Button>
        ) : editable ? (
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
  const projectId = resolveCapabilitiesProjectIdForView(groups, environmentId, projectKey);
  const projectLocked = projectKey !== null;
  const effectiveScope: OmpCapabilityScope = projectLocked ? "project" : "global";
  const [query, setQuery] = useState("");
  // Moving a global-origin setting into the project copies its current value
  // into the project layer (the existing writeSetting path).
  const [movingKey, setMovingKey] = useState<string | null>(null);
  // Project-scoped adds: a new key is written straight into the project
  // layer — the list only shows keys the project already overrides.
  const [addingSetting, setAddingSetting] = useState(false);
  const [newSettingKey, setNewSettingKey] = useState("");
  const [newSettingValue, setNewSettingValue] = useState("");
  const [addingBusy, setAddingBusy] = useState(false);
  const writeSetting = useAtomCommand(serverEnvironment.capabilitiesWriteSetting, {
    label: "capabilities-write-setting",
  });
  const moveSettingToProject = async (row: CapabilitiesSettingsRow) => {
    if (environmentId === null || projectId === null || row.value === undefined) return;
    setMovingKey(row.key);
    const result = await writeSetting({
      environmentId,
      input: buildWriteSettingInput({
        key: row.key,
        value: row.value,
        scope: "project",
        projectId,
      }),
    });
    setMovingKey(null);
    if (result._tag === "Failure") {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not move ${row.key}`,
          description: "Check that omp is installed on the server host and try again.",
        }),
      );
      return;
    }
    toastManager.add({ type: "success", title: `Moved ${row.key} to project` });
    refreshSnapshot();
  };

  const addSetting = async () => {
    const key = newSettingKey.trim();
    if (environmentId === null || !isValidSettingKey(key)) return;
    if (effectiveScope === "project" && projectId === null) return;
    setAddingBusy(true);
    const result = await writeSetting({
      environmentId,
      input: buildWriteSettingInput({
        key,
        value: newSettingValue,
        scope: effectiveScope,
        projectId,
      }),
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
    <SettingsPageContainer className="max-w-6xl">
      <SettingsSection title="Settings">
        <SettingsRow
          title="Scope"
          description={
            projectLocked
              ? "Writes and resets apply to this project's .omp config."
              : "Writes and resets apply to the global omp agent directory."
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
        </div>
        {addingSetting ? (
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
                addingBusy ||
                !isValidSettingKey(newSettingKey.trim()) ||
                (effectiveScope === "project" && projectId === null)
              }
              onClick={() => void addSetting()}
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
            <p className="w-full text-xs leading-relaxed text-muted-foreground">
              Only needed for a setting omp does not list yet (for example{" "}
              <span className="font-mono">modelRoles.default</span>); every known setting can be
              moved from the global list instead. Key is a dotted name, value is what to set.
            </p>
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
                Add the first project-level setting — it lands in this project's .omp config. Known
                setting keys and their types are listed on the global Settings page.
              </span>
            </div>
          ) : (
            <SettingsRow title="No settings" description="omp reported no config settings." />
          )
        ) : (
          <div className="overflow-x-auto">
            <table className="w-max min-w-full text-left text-xs">
              <thead className="border-b border-border/60 text-[11px] uppercase tracking-[0.08em] text-muted-foreground/70">
                <tr>
                  <th className="px-4 py-2 font-semibold sm:pl-5">Key</th>
                  <th className="px-3 py-2 font-semibold">Type</th>
                  <th className="px-3 py-2 font-semibold">Description</th>
                  <th className="px-3 py-2 font-semibold">Value</th>
                  <th className="sticky right-0 z-10 bg-background py-2 pe-6 ps-5 text-right font-semibold">
                    Actions
                  </th>
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
                    {...(projectLocked && row.scope === "global"
                      ? { onMoveToProject: () => void moveSettingToProject(row) }
                      : {})}
                    moving={movingKey === row.key}
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
