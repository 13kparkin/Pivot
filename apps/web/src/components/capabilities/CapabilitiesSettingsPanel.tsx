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
import { LoaderIcon, PencilIcon, SaveIcon, SearchIcon, Undo2Icon } from "lucide-react";
import { useState } from "react";

import { useActiveEnvironmentId } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSettingsProjectGroups } from "../settings/ProjectSettingsPanel";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";

import { CapabilitiesSettingDialog } from "./CapabilitiesSettingDialog";
import {
  buildPrecedenceLabel,
  buildSettingRows,
  buildWriteSettingInput,
  canEditEntry,
  filterSettingRows,
  formatSettingValue,
  parseSettingDraft,
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
  onEdit,
  onMutated,
}: {
  entry: CapabilitiesSettingsRow;
  scope: OmpCapabilityScope;
  environmentId: EnvironmentId;
  projectId: ProjectId | null;
  onEdit: () => void;
  onMutated: () => void;
}) {
  const isBoolean = entry.type === "boolean";
  const isStructured = entry.type === "record" || entry.type === "array";
  const enumValues =
    entry.type === "enum" && (entry.values?.length ?? 0) > 0 ? entry.values : undefined;
  const [draft, setDraft] = useState(() => (entry.masked ? "" : formatSettingValue(entry.value)));
  const [booleanDraft, setBooleanDraft] = useState(() =>
    entry.masked ? false : Boolean(entry.value ?? false),
  );
  const [draftError, setDraftError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "reset" | null>(null);
  const writeSetting = useAtomCommand(serverEnvironment.capabilitiesWriteSetting, {
    label: "capabilities-write-setting",
  });
  const resetSetting = useAtomCommand(serverEnvironment.capabilitiesResetSetting, {
    label: "capabilities-reset-setting",
  });
  // Keep the current enum value selectable even when it is stale relative to
  // the reported choices (e.g. a value written by an older omp version).
  const selectValues =
    enumValues !== undefined && draft.length > 0 && !enumValues.includes(draft)
      ? [draft, ...enumValues]
      : enumValues;

  const save = async () => {
    setBusy("save");
    const parsed = isBoolean
      ? ({ ok: true, value: booleanDraft } as const)
      : parseSettingDraft(entry.type, draft);
    if (!parsed.ok) {
      setDraftError(parsed.error);
      setBusy(null);
      return;
    }
    const result = await writeSetting({
      environmentId,
      input: buildWriteSettingInput({ key: entry.key, value: parsed.value, scope, projectId }),
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
      <td className="max-w-64 px-3 py-2">
        {!editable ? (
          <span className="font-mono text-muted-foreground">{entry.displayValue}</span>
        ) : isStructured ? (
          <span className="block truncate font-mono text-xs text-foreground/90">
            {entry.displayValue}
          </span>
        ) : isBoolean ? (
          <Switch
            checked={booleanDraft}
            onCheckedChange={(checked) => {
              setBooleanDraft(Boolean(checked));
              setDraftError(null);
            }}
            aria-label={`Value for ${entry.key}`}
          />
        ) : enumValues !== undefined ? (
          <Select
            value={draft}
            onValueChange={(value) => {
              if (typeof value === "string") setDraft(value);
              setDraftError(null);
            }}
          >
            <SelectTrigger className="h-7 w-44" aria-label={`Value for ${entry.key}`}>
              <SelectValue placeholder="Unset" />
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {(selectValues ?? []).map((value) => (
                <SelectItem hideIndicator key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : (
          <Input
            size="sm"
            className="h-7 min-w-40 font-mono text-xs"
            value={draft}
            onChange={(event) => {
              setDraft(event.currentTarget.value);
              setDraftError(null);
            }}
            placeholder="Unset"
            aria-label={`Value for ${entry.key}`}
          />
        )}
        {draftError !== null && !isStructured ? (
          <span className="mt-0.5 block text-[11px] text-destructive">{draftError}</span>
        ) : null}
      </td>
      <td className="px-3 py-2 text-right">
        {editable ? (
          <div className="inline-flex items-center gap-1.5">
            {isStructured ? (
              <Button type="button" size="sm" className="h-7 px-2 text-xs" onClick={onEdit}>
                <PencilIcon className="size-3.5" />
                Edit
              </Button>
            ) : (
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
            )}
            {hasValue ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                disabled={busy !== null}
                onClick={() => void reset()}
              >
                {busy === "reset" ? (
                  <LoaderIcon className="size-3.5 animate-spin" />
                ) : (
                  <Undo2Icon className="size-3.5" />
                )}
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
  const [query, setQuery] = useState("");
  const [editingEntryKey, setEditingEntryKey] = useState<string | null>(null);

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

  const rows = filterSettingRows(buildSettingRows(snapshot.settings.entries), query);
  const editingEntry = rows.find((row) => row.key === editingEntryKey) ?? null;

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
        <div className="relative max-w-72">
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
        {rows.length === 0 ? (
          <SettingsRow
            title={query.trim().length > 0 ? "No matching settings" : "No settings"}
            description={
              query.trim().length > 0
                ? "No settings match the current search."
                : "omp reported no config settings."
            }
          />
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
                    onEdit={() => setEditingEntryKey(row.key)}
                    onMutated={refreshSnapshot}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SettingsSection>
      {editingEntry !== null ? (
        <CapabilitiesSettingDialog
          key={editingEntry.key}
          entry={editingEntry}
          scope={effectiveScope}
          environmentId={environmentId}
          projectId={projectId}
          onOpenChange={(open) => {
            if (!open) setEditingEntryKey(null);
          }}
          onMutated={refreshSnapshot}
        />
      ) : null}
    </SettingsPageContainer>
  );
}
