"use client";

import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { OmpCapabilityScope, ProviderInstanceId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { LoaderIcon, PlusIcon, Trash2Icon } from "lucide-react";
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
  type ProviderInstanceEntry,
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
    <SettingsPageContainer className="max-w-4xl">
      <SettingsSection title="Models & roles">
        <SettingsRow
          title="Scope"
          description={
            projectLocked
              ? "Roles apply to this project's .omp config."
              : "Roles apply to the global omp agent directory."
          }
        />
        <SettingsRow
          title="What roles do"
          description="A role maps a name (review, plan, …) to a model. The review agent uses the 'review' role when it is set; otherwise it falls back to your current model."
        />
      </SettingsSection>

      <SettingsSection title="Roles">
        {defaultInstanceId === null ? (
          <p className="text-sm text-muted-foreground">
            Connect a provider to pick models for your roles.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {roleEntries.length === 0 ? (
              <p className="text-sm text-muted-foreground">No roles yet — add one below.</p>
            ) : (
              roleEntries.map(([role, model]) => (
                <div key={role} className="flex items-center gap-3">
                  <span className="w-32 shrink-0 truncate font-mono text-sm text-foreground">
                    {role}
                  </span>
                  <div className="min-w-0 flex-1">
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
                  </div>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                    aria-label={`Delete role ${role}`}
                    onClick={() => deleteRole(role)}
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </div>
              ))
            )}
            <div className="mt-2 flex items-center gap-3 rounded-lg border border-border/70 p-3">
              <label className="flex min-w-32 flex-1 flex-col gap-1 text-xs text-muted-foreground">
                Role name
                <Input
                  size="sm"
                  className="h-8 font-mono"
                  value={newRoleName}
                  onChange={(event) => setNewRoleName(event.currentTarget.value)}
                  placeholder="review"
                  aria-label="New role name"
                  autoFocus
                />
              </label>
              <div className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-muted-foreground">
                Model
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
              </div>
              <Button
                type="button"
                size="sm"
                className="mt-5 h-8 shrink-0 px-2.5 text-xs"
                disabled={newRoleName.trim().length === 0 || newRoleModel.length === 0}
                onClick={addRole}
              >
                <PlusIcon className="size-3.5" />
                Add role
              </Button>
            </div>
          </div>
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
