"use client";

import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { OmpCapabilityScope, ProviderInstanceId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { LoaderIcon, MinusIcon, PlusIcon, SearchIcon, Trash2Icon } from "lucide-react";
import { useMemo, useState } from "react";

import { useActiveEnvironmentId } from "../../state/entities";
import { primaryServerProvidersAtom, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { usePrimarySettings } from "../../hooks/useSettings";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useSettingsProjectGroups } from "../settings/ProjectSettingsPanel";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { stackedThreadToast, toastManager } from "../ui/toast";

import { modelRolesFromSettingsEntries } from "./CapabilitiesModelsRolesPanel.logic";
import { resolveCapabilitiesProjectIdForView } from "./CapabilitiesOverviewPanel.logic";
import { buildWriteSettingInput } from "./CapabilitiesSettingsPanel.logic";

const EMPTY_SNAPSHOT_ATOM = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel("web-capabilities:snapshot:models-roles:empty"),
);

const TABLE_HEAD =
  "px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70";

/**
 * The omp `modelRoles` record: one entry per role (`review`, `plan`, …), each
 * mapped to a model slug. Writes go through the whole record so a role change
 * never clobbers the others, matching the settings modal's write path.
 */
export function CapabilitiesModelsRolesPanel({
  projectKey = null,
}: {
  projectKey?: string | null;
}) {
  const environmentId = useActiveEnvironmentId();
  const groups = useSettingsProjectGroups();
  const projectId = resolveCapabilitiesProjectIdForView(groups, environmentId, projectKey);
  const projectLocked = projectKey !== null;
  const effectiveScope: OmpCapabilityScope = projectLocked ? "project" : "global";
  const settings = usePrimarySettings();
  const serverProviders = useAtomValue(primaryServerProvidersAtom);

  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(serverProviders), settings),
      ),
    [serverProviders, settings],
  );
  const modelOptionsByInstance = useMemo(
    () => getCustomModelOptionsByInstance(settings, serverProviders),
    [serverProviders, settings],
  );
  const defaultInstanceId = instanceEntries[0]?.instanceId ?? null;

  const writeSetting = useAtomCommand(serverEnvironment.capabilitiesWriteSetting, {
    label: "capabilities-write-setting",
  });
  const resetSetting = useAtomCommand(serverEnvironment.capabilitiesResetSetting, {
    label: "capabilities-reset-setting",
  });

  const [newRoleName, setNewRoleName] = useState("");
  const [newRoleModel, setNewRoleModel] = useState("");
  const [modelQuery, setModelQuery] = useState("");
  const [showAllModels, setShowAllModels] = useState(false);

  const snapshotAtom =
    environmentId === null
      ? EMPTY_SNAPSHOT_ATOM
      : serverEnvironment.capabilitiesSnapshot({
          environmentId,
          input: projectId === null ? {} : { projectId },
        });
  const result = useAtomValue(snapshotAtom);
  const refreshSnapshot = useAtomRefresh(snapshotAtom);
  const snapshot = Option.getOrNull(AsyncResult.value(result))?.snapshot ?? null;
  const roles = useMemo(
    () => (snapshot === null ? {} : modelRolesFromSettingsEntries(snapshot.settings.entries)),
    [snapshot],
  );

  /** Every available model across instances, for the Models catalog. */
  const allModels = useMemo(() => {
    const rows: Array<{
      readonly slug: string;
      readonly name: string;
      readonly shortName: string | undefined;
      readonly provider: string;
    }> = [];
    for (const entry of instanceEntries) {
      const options = modelOptionsByInstance.get(entry.instanceId) ?? [];
      for (const option of options) {
        rows.push({
          slug: option.slug,
          name: option.name,
          shortName: option.shortName,
          provider: entry.displayName || entry.driverKind,
        });
      }
    }
    return rows;
  }, [instanceEntries, modelOptionsByInstance]);

  const filteredModels = useMemo(() => {
    const query = modelQuery.trim().toLowerCase();
    if (query.length === 0) return allModels;
    return allModels.filter(
      (model) =>
        model.name.toLowerCase().includes(query) ||
        model.slug.toLowerCase().includes(query) ||
        model.provider.toLowerCase().includes(query),
    );
  }, [allModels, modelQuery]);

  // Show the first 10 models with a "+ View all models" button; the slice resets
  // whenever the search query changes so a new search collapses back to 10.
  const visibleModels = useMemo(
    () => (showAllModels ? filteredModels : filteredModels.slice(0, 10)),
    [filteredModels, showAllModels],
  );

  /** The instance whose options contain this model slug, or the default. */
  const instanceForModel = (slug: string): ProviderInstanceId | null => {
    if (defaultInstanceId === null) return null;
    if (slug.length === 0) return defaultInstanceId;
    for (const entry of instanceEntries) {
      const options = modelOptionsByInstance.get(entry.instanceId) ?? [];
      if (options.some((option) => option.slug === slug)) return entry.instanceId;
    }
    return defaultInstanceId;
  };

  const reportFailure = (action: string) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: `Could not ${action} model role`,
        description: "Check that omp is installed on the server host and try again.",
      }),
    );
  };

  const writeRoles = async (next: Readonly<Record<string, string>>) => {
    if (environmentId === null) return;
    const outcome = await writeSetting({
      environmentId,
      input: buildWriteSettingInput({
        key: "modelRoles",
        value: { ...next },
        scope: effectiveScope,
        projectId,
      }),
    });
    if (outcome._tag === "Failure") {
      reportFailure("save");
      return;
    }
    toastManager.add({ type: "success", title: "Saved model roles" });
    refreshSnapshot();
  };

  const setRoleModel = (role: string, model: string) => {
    void writeRoles({ ...roles, [role]: model });
  };

  const deleteRole = (role: string) => {
    const next = { ...roles };
    delete next[role];
    if (Object.keys(next).length === 0) {
      if (environmentId === null) return;
      void resetSetting({
        environmentId,
        input: {
          key: "modelRoles",
          scope: effectiveScope,
          confirm: true,
          ...(projectId === null ? {} : { projectId }),
        },
      }).then((outcome) => {
        if (outcome._tag === "Failure") {
          reportFailure("reset");
          return;
        }
        toastManager.add({ type: "success", title: "Cleared model roles" });
        refreshSnapshot();
      });
      return;
    }
    void writeRoles(next);
  };

  const addRole = () => {
    const name = newRoleName.trim();
    if (name.length === 0 || newRoleModel.length === 0) return;
    void writeRoles({ ...roles, [name]: newRoleModel });
    setNewRoleName("");
    setNewRoleModel("");
  };

  if (environmentId === null) {
    return (
      <SettingsPageContainer>
        <p className="text-sm text-muted-foreground">
          Connect an environment to edit its model roles.
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
            Loading model roles…
          </div>
        </SettingsPageContainer>
      );
    }
    return (
      <SettingsPageContainer>
        <div className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-foreground">Could not load model roles</span>
          <span className="text-muted-foreground">
            Check that omp is installed on the server host and try again.
          </span>
        </div>
      </SettingsPageContainer>
    );
  }

  const roleEntries = Object.entries(roles).sort(([a], [b]) => a.localeCompare(b));

  return (
    <SettingsPageContainer className="max-w-5xl">
      <SettingsSection title="Scope">
        <SettingsRow
          title="Scope"
          description={
            projectLocked
              ? "Models and roles apply to this project's .omp config."
              : "Models and roles apply to the global omp agent directory."
          }
        />
      </SettingsSection>

      <SettingsSection title="Models">
        <SettingsRow
          title="Available models"
          description="Every model your connected providers expose. Assign one to a role below."
        />
        <div className="relative max-w-xs">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/70" />
          <Input
            size="sm"
            type="search"
            value={modelQuery}
            onChange={(event) => setModelQuery(event.currentTarget.value)}
            placeholder="Search models"
            aria-label="Search models"
            className="h-8 pl-8"
          />
        </div>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-border/60">
              <tr>
                <th className={TABLE_HEAD}>Model</th>
                <th className={TABLE_HEAD}>Provider</th>
                <th className={TABLE_HEAD}>Slug</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {filteredModels.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-3 py-4 text-muted-foreground">
                    {modelQuery.trim().length > 0
                      ? "No models match the current search."
                      : "No models available — connect a provider."}
                  </td>
                </tr>
              ) : (
                visibleModels.map((model) => (
                  <tr key={model.slug} className="hover:bg-accent/40">
                    <td className="px-3 py-2 font-medium text-foreground">
                      {model.name}
                      {model.shortName ? (
                        <span className="ml-1.5 text-muted-foreground/70">{model.shortName}</span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{model.provider}</td>
                    <td className="px-3 py-2 font-mono text-muted-foreground/80">{model.slug}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {filteredModels.length > 10 ? (
          <button
            type="button"
            onClick={() => setShowAllModels((open) => !open)}
            className="mt-1 flex h-10 w-full items-center justify-start gap-1.5 rounded-md px-3 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {showAllModels ? (
              <MinusIcon className="size-3.5 shrink-0" />
            ) : (
              <PlusIcon className="size-3.5 shrink-0" />
            )}
            {showAllModels ? "Show fewer" : "View all models"}
            <span className="text-muted-foreground/60">({filteredModels.length})</span>
          </button>
        ) : null}
      </SettingsSection>

      <SettingsSection title="Roles">
        <SettingsRow
          title="Role to model mapping"
          description="A role names a model for a specific job. The review agent uses the 'review' role when it is set; otherwise it falls back to your current model."
        />
        {defaultInstanceId === null ? (
          <p className="text-sm text-muted-foreground">
            Connect a provider to pick models for your roles.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-border/60">
                <tr>
                  <th className={TABLE_HEAD + " w-40"}>Role</th>
                  <th className={TABLE_HEAD}>Model</th>
                  <th className={"sticky right-0 z-10 bg-background " + TABLE_HEAD + " text-right"}>
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {roleEntries.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-3 py-4 text-muted-foreground">
                      No roles yet — add one below.
                    </td>
                  </tr>
                ) : (
                  roleEntries.map(([role, model]) => (
                    <tr key={role} className="hover:bg-accent/40">
                      <td className="w-40 px-3 py-2 font-mono font-medium text-foreground">
                        {role}
                      </td>
                      <td className="px-3 py-2">
                        <ProviderModelPicker
                          activeInstanceId={instanceForModel(model) ?? defaultInstanceId}
                          model={model}
                          lockedProvider={null}
                          instanceEntries={instanceEntries}
                          modelOptionsByInstance={modelOptionsByInstance}
                          triggerVariant="outline"
                          triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                          onInstanceModelChange={(_instanceId, nextModel) =>
                            setRoleModel(role, nextModel)
                          }
                        />
                      </td>
                      <td className="sticky right-0 z-10 bg-background py-2 pe-4 ps-3 text-right">
                        <Button
                          type="button"
                          size="icon-sm"
                          variant="ghost"
                          className="text-muted-foreground hover:text-destructive"
                          aria-label={`Delete role ${role}`}
                          onClick={() => deleteRole(role)}
                        >
                          <Trash2Icon className="size-3.5" />
                        </Button>
                      </td>
                    </tr>
                  ))
                )}
                <tr className="border-t border-border/60 bg-muted/20">
                  <td className="w-40 px-3 py-2">
                    <Input
                      size="sm"
                      className="h-8 font-mono"
                      value={newRoleName}
                      onChange={(event) => setNewRoleName(event.currentTarget.value)}
                      placeholder="review"
                      aria-label="New role name"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <ProviderModelPicker
                      activeInstanceId={defaultInstanceId}
                      model={newRoleModel}
                      lockedProvider={null}
                      instanceEntries={instanceEntries}
                      modelOptionsByInstance={modelOptionsByInstance}
                      triggerVariant="outline"
                      triggerClassName="min-w-0 max-w-none shrink-0 text-foreground/90 hover:text-foreground"
                      onInstanceModelChange={(_instanceId, model) => setNewRoleModel(model)}
                    />
                  </td>
                  <td className="sticky right-0 z-10 bg-muted/20 py-2 pe-4 ps-3 text-right">
                    <Button
                      type="button"
                      size="sm"
                      className="h-8 px-2.5 text-xs"
                      disabled={newRoleName.trim().length === 0 || newRoleModel.length === 0}
                      onClick={addRole}
                    >
                      <PlusIcon className="size-3.5" />
                      Add role
                    </Button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
