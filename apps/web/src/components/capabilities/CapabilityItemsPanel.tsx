"use client";

import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  OmpCapabilityEditableKind,
  OmpCapabilityItem,
  OmpCapabilityItemScope,
  ProjectId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import {
  LoaderIcon,
  MoveRightIcon,
  PencilIcon,
  PlusIcon,
  SaveIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { useActiveEnvironmentId } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSettingsProjectGroups } from "../settings/ProjectSettingsPanel";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settings/settingsLayout";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";

import { resolveCapabilitiesProjectId } from "./CapabilitiesOverviewPanel.logic";
import {
  NEW_RULE_TEMPLATE,
  NEW_SKILL_TEMPLATE,
  buildItemRows,
  filterItemRows,
  isValidItemName,
  withTemplateName,
} from "./CapabilityItemsPanel.logic";

const EMPTY_ITEMS_SNAPSHOT_ATOM = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel("web-capabilities:snapshot:items:empty"),
);

type EditorState =
  | { readonly mode: "create" }
  | { readonly mode: "edit"; readonly item: OmpCapabilityItem };

interface ItemEditorDialogProps {
  readonly kind: OmpCapabilityEditableKind;
  readonly itemLabel: string;
  readonly editor: EditorState;
  /** Project view: creates are locked to the project scope (no Global option). */
  readonly projectLocked: boolean;
  readonly projectId: ProjectId | null;
  readonly environmentId: EnvironmentId;
  readonly onClose: () => void;
  readonly onMutated: () => void;
}

function ItemEditorDialog({
  kind,
  itemLabel,
  editor,
  projectLocked,
  projectId,
  environmentId,
  onClose,
  onMutated,
}: ItemEditorDialogProps) {
  const isEdit = editor.mode === "edit";
  const [name, setName] = useState(isEdit ? editor.item.name : "");
  const [scope, setScope] = useState<OmpCapabilityItemScope>(
    projectLocked ? "project" : isEdit ? editor.item.scope : "global",
  );
  const [content, setContent] = useState(
    isEdit ? "" : kind === "rules" ? NEW_RULE_TEMPLATE : withTemplateName(NEW_SKILL_TEMPLATE, ""),
  );
  const [loading, setLoading] = useState(isEdit);
  const [saving, setSaving] = useState(false);
  const writeResource = useAtomCommand(serverEnvironment.capabilitiesWriteResource, {
    label: "capabilities-write-resource",
  });
  const readResource = useAtomCommand(serverEnvironment.capabilitiesReadResource, {
    label: "capabilities-read-resource",
  });

  // Editing loads the current file contents; create starts from the template.
  useEffect(() => {
    if (!isEdit) return;
    let cancelled = false;
    setLoading(true);
    void readResource({
      environmentId,
      input: {
        kind,
        name: editor.item.name,
        scope: editor.item.scope,
        ...(editor.item.scope === "project" && projectId !== null ? { projectId } : {}),
      },
    }).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Could not load ${itemLabel} ${editor.item.name}`,
            description:
              error instanceof Error
                ? error.message
                : "Check that omp is installed on the server host.",
          }),
        );
        return;
      }
      if (result.value.resource.exists === false) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `${itemLabel} ${editor.item.name} no longer exists`,
            description: "It may have been removed outside of the app.",
          }),
        );
        return;
      }
      setContent(result.value.resource.content);
    });
    return () => {
      cancelled = true;
    };
    // The dialog is keyed by editor state; load exactly once per open.
  }, [editor, environmentId, isEdit, itemLabel, kind, projectId, readResource]);

  const nameError = name.trim().length === 0 || !isValidItemName(name.trim());
  const canSave =
    !loading &&
    !saving &&
    !nameError &&
    content.trim().length > 0 &&
    // A project-scoped create needs the resolved project to write into.
    (!projectLocked || projectId !== null);

  const save = async () => {
    const trimmedName = name.trim();
    if (!isValidItemName(trimmedName) || content.trim().length === 0) return;
    setSaving(true);
    const result = await writeResource({
      environmentId,
      input: {
        kind,
        name: trimmedName,
        content: kind === "skills" ? withTemplateName(content, trimmedName) : content,
        scope,
        overwrite: isEdit,
        ...(scope === "project" && projectId !== null ? { projectId } : {}),
      },
    });
    setSaving(false);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not save ${itemLabel} ${trimmedName}`,
          description:
            error instanceof Error
              ? error.message
              : "Check that omp is installed on the server host.",
        }),
      );
      return;
    }
    toastManager.add({ type: "success", title: `Saved ${itemLabel} ${trimmedName}` });
    onMutated();
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? `Edit ${itemLabel}` : `New ${itemLabel}`}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? `${itemLabel} files are plain markdown with optional frontmatter.`
              : `Create a ${itemLabel} in ${scope === "global" ? "the global omp agent directory" : "the project's .omp folder"}.`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-foreground">Name</span>
              <Input
                size="sm"
                value={name}
                disabled={isEdit}
                placeholder={kind === "rules" ? "codegraph" : "create-ticket"}
                aria-label="Item name"
                aria-invalid={name.trim().length > 0 && nameError}
                onChange={(event) => setName(event.currentTarget.value)}
              />
              {name.trim().length > 0 && nameError ? (
                <span className="mt-1 block text-[11px] text-destructive-foreground">
                  Letters, digits, dots, dashes and underscores — no spaces or slashes.
                </span>
              ) : null}
            </label>
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-foreground">Scope</span>
              <Select
                value={scope}
                disabled={isEdit || projectLocked}
                onValueChange={(value) => {
                  if (value === "global" || value === "project") setScope(value);
                }}
              >
                <SelectTrigger className="w-full" aria-label="Item scope">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup align="start" alignItemWithTrigger={false}>
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
            </label>
          </div>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">Contents</span>
            <div className="relative">
              <Textarea
                className="[&_textarea]:min-h-64 [&_textarea]:font-mono [&_textarea]:text-xs"
                value={loading ? "" : content}
                readOnly={loading}
                placeholder={loading ? "Loading…" : "Markdown with optional frontmatter"}
                aria-label="Item contents"
                onChange={(event) => setContent(event.currentTarget.value)}
              />
              {loading ? (
                <LoaderIcon className="absolute right-3 top-3 size-4 animate-spin text-muted-foreground" />
              ) : null}
            </div>
          </label>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button type="button" variant="outline" size="sm" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" size="sm" disabled={!canSave} onClick={() => void save()}>
            {saving ? (
              <LoaderIcon className="size-3.5 animate-spin" />
            ) : (
              <SaveIcon className="size-3.5" />
            )}
            {isEdit ? "Save changes" : "Create"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function ItemRowActions({
  item,
  itemLabel,
  moving,
  onMove,
  onEdit,
  onDelete,
}: {
  readonly item: OmpCapabilityItem;
  readonly itemLabel: string;
  readonly moving: boolean;
  readonly onMove: () => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}) {
  // Foreign-root items (skills discovered in another CLI's skill directory)
  // cannot be edited in place; moving them into the omp agent directory is
  // the only mutation, so it replaces Edit/Delete.
  if (item.scope === "global" && item.sourceDir !== undefined) {
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={moving}
        aria-label={`Move ${itemLabel} ${item.name} to omp`}
        onClick={onMove}
      >
        {moving ? (
          <LoaderIcon className="size-3.5 animate-spin" />
        ) : (
          <MoveRightIcon className="size-3.5" />
        )}
        Move to omp
      </Button>
    );
  }
  return (
    <div className="inline-flex items-center gap-1">
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        className="text-muted-foreground hover:text-foreground"
        aria-label={`Edit ${itemLabel} ${item.name}`}
        onClick={onEdit}
      >
        <PencilIcon className="size-3.5" />
      </Button>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        className="text-muted-foreground hover:text-destructive-foreground"
        aria-label={`Delete ${itemLabel} ${item.name}`}
        onClick={onDelete}
      >
        <Trash2Icon className="size-3.5" />
      </Button>
    </div>
  );
}

/** Per-kind copy for the rules/skills editor. Keyed by kind so both panels share one source. */
const PANEL_COPY: Readonly<
  Record<
    OmpCapabilityEditableKind,
    {
      readonly title: string;
      readonly description: string;
      readonly itemLabel: string;
      readonly scopeHint: string;
      readonly shadowHint: string;
      /** Project-scoped view: the info box describes the project's own items. */
      readonly projectScopeHint: string;
      readonly projectShadowHint: string;
    }
  >
> = {
  rules: {
    title: "Rules",
    description: "Rules are loaded into every session and shape how the agent behaves.",
    itemLabel: "rule",
    scopeHint:
      "Global rules live in the omp agent directory; project rules live under the project's .omp folder.",
    shadowHint: "A project rule with the same name shadows the global rule for that project.",
    projectScopeHint: "Rules live in this project's .omp folder and load into every session.",
    projectShadowHint:
      "A project rule with the same name shadows the rule in the omp agent directory.",
  },
  skills: {
    title: "Skills",
    description: "Skills are invoked on demand when a task matches their description.",
    itemLabel: "skill",
    scopeHint:
      "Global skills live in the omp agent directory; project skills live under the project's .omp folder.",
    shadowHint:
      "Project and global skills coexist — a project skill is available in addition to the same-named global one.",
    projectScopeHint:
      "Skills live in this project's .omp folder and run when a task matches their description.",
    projectShadowHint:
      "A project skill with the same name is available in addition to the one in the omp agent directory.",
  },
};

/**
 * Rules/skills editor for the active omp environment: one list for every
 * global and project item, with search, create, edit and delete. Global items
 * live in the omp agent directory; project items under the project's `.omp`
 * folder. With a project targeted (`projectKey`), only that project's items
 * are listed and creates are locked to the project scope.
 */
export function CapabilityItemsPanel({
  kind,
  projectKey = null,
}: {
  readonly kind: OmpCapabilityEditableKind;
  readonly projectKey?: string | null;
}) {
  const {
    title,
    description,
    itemLabel,
    scopeHint,
    shadowHint,
    projectScopeHint,
    projectShadowHint,
  } = PANEL_COPY[kind];
  const environmentId = useActiveEnvironmentId();
  const groups = useSettingsProjectGroups();
  const projectId = resolveCapabilitiesProjectId(groups, environmentId, projectKey);
  const projectLocked = projectKey !== null;
  const effectiveScopeHint = projectLocked ? projectScopeHint : scopeHint;
  const effectiveShadowHint = projectLocked ? projectShadowHint : shadowHint;
  const [query, setQuery] = useState("");
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<OmpCapabilityItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [movingName, setMovingName] = useState<string | null>(null);

  const snapshotAtom =
    environmentId === null
      ? EMPTY_ITEMS_SNAPSHOT_ATOM
      : serverEnvironment.capabilitiesSnapshot({
          environmentId,
          input: projectId === null ? {} : { projectId },
        });
  const result = useAtomValue(snapshotAtom);
  const refreshSnapshot = useAtomRefresh(snapshotAtom);
  const snapshot = Option.getOrNull(AsyncResult.value(result))?.snapshot ?? null;
  const deleteResource = useAtomCommand(serverEnvironment.capabilitiesDeleteResource, {
    label: "capabilities-delete-resource",
  });
  const moveItem = useAtomCommand(serverEnvironment.capabilitiesMoveItem, {
    label: "capabilities-move-item",
  });

  if (environmentId === null) {
    return (
      <SettingsPageContainer>
        <p className="text-sm text-muted-foreground">
          Connect an environment to manage its {itemLabel}s.
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
            Loading {itemLabel}s…
          </div>
        </SettingsPageContainer>
      );
    }
    return (
      <SettingsPageContainer>
        <div className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-foreground">Could not load omp {itemLabel}s</span>
          <span className="text-muted-foreground">
            Check that omp is installed on the server host and try again.
          </span>
        </div>
      </SettingsPageContainer>
    );
  }

  // Project snapshots still carry global items; project views surface only
  // the project's own rules/skills.
  const items = kind === "rules" ? snapshot.rules : snapshot.skills;
  const sourceItems = projectLocked ? items.filter((item) => item.scope === "project") : items;
  const rows = filterItemRows(buildItemRows(sourceItems), query);
  const searching = query.trim().length > 0;

  const confirmDelete = async () => {
    if (deleteTarget === null) return;
    setDeleting(true);
    const result = await deleteResource({
      environmentId,
      input: {
        kind,
        name: deleteTarget.name,
        scope: deleteTarget.scope,
        confirm: true,
        ...(deleteTarget.scope === "project" && projectId !== null ? { projectId } : {}),
      },
    });
    setDeleting(false);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not delete ${itemLabel} ${deleteTarget.name}`,
          description:
            error instanceof Error
              ? error.message
              : "Check that omp is installed on the server host.",
        }),
      );
      return;
    }
    toastManager.add({ type: "success", title: `Deleted ${itemLabel} ${deleteTarget.name}` });
    setDeleteTarget(null);
    refreshSnapshot();
  };

  const confirmMove = async (name: string) => {
    setMovingName(name);
    const result = await moveItem({
      environmentId,
      input: { kind, name },
    });
    setMovingName(null);
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Could not move ${itemLabel} ${name} to omp`,
          description:
            error instanceof Error
              ? error.message
              : "Check that omp is installed on the server host.",
        }),
      );
      return;
    }
    toastManager.add({ type: "success", title: `Moved ${itemLabel} ${name} into omp` });
    refreshSnapshot();
  };

  return (
    <SettingsPageContainer>
      <SettingsSection
        title={title}
        headerAction={
          <Button type="button" size="sm" onClick={() => setEditor({ mode: "create" })}>
            <PlusIcon className="size-3.5" />
            New {itemLabel}
          </Button>
        }
      >
        <SettingsRow title="How it works" description={description} />
        <SettingsRow title="Where items live" description={effectiveScopeHint} />
        <SettingsRow title="Project overrides" description={effectiveShadowHint} />
      </SettingsSection>
      <SettingsSection title={`All ${itemLabel}s`}>
        <div className="relative max-w-72">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/70" />
          <Input
            size="sm"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder={`Search ${itemLabel}s`}
            aria-label={`Search ${itemLabel}s`}
            className="h-8 pl-8"
          />
        </div>
        {rows.length === 0 ? (
          <SettingsRow
            title={searching ? `No matching ${itemLabel}s` : `No ${itemLabel}s`}
            description={
              searching
                ? `No ${itemLabel}s match the current search.`
                : `No ${itemLabel}s exist yet. Create one to get started.`
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-xs">
              <thead className="border-b border-border/60 text-[11px] uppercase tracking-[0.08em] text-muted-foreground/70">
                <tr>
                  <th className="px-4 py-2 font-semibold sm:pl-5">Name</th>
                  <th className="px-3 py-2 font-semibold">Description</th>
                  <th className="px-3 py-2 font-semibold">Scope</th>
                  <th className="px-3 py-2 text-right font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {rows.map((row) => {
                  const foreignRoot = row.scope === "global" && row.sourceDir !== undefined;
                  return (
                    <tr key={`${row.scope}:${row.name}`}>
                      <td className="px-4 py-2 sm:pl-5">
                        <span className="inline-flex items-center gap-2">
                          <span className="font-mono font-medium text-foreground">{row.name}</span>
                          {row.shadowed ? (
                            <Badge size="sm" variant="warning">
                              Overrides global
                            </Badge>
                          ) : null}
                        </span>
                        {foreignRoot ? (
                          <span className="mt-0.5 block text-[11px] text-muted-foreground">
                            Lives in {row.sourceDir}
                          </span>
                        ) : null}
                      </td>
                      <td className="max-w-96 px-3 py-2 text-muted-foreground">
                        <span className="line-clamp-2">{row.description}</span>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{row.scopeLabel}</td>
                      <td className="px-3 py-2 text-right">
                        <ItemRowActions
                          item={row}
                          itemLabel={itemLabel}
                          moving={foreignRoot && movingName === row.name}
                          onMove={() => void confirmMove(row.name)}
                          onEdit={() => setEditor({ mode: "edit", item: row })}
                          onDelete={() => setDeleteTarget(row)}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SettingsSection>

      {editor !== null ? (
        <ItemEditorDialog
          key={editor.mode === "edit" ? `edit:${editor.item.scope}:${editor.item.name}` : "create"}
          kind={kind}
          itemLabel={itemLabel}
          editor={editor}
          projectLocked={projectLocked}
          projectId={projectId}
          environmentId={environmentId}
          onClose={() => setEditor(null)}
          onMutated={refreshSnapshot}
        />
      ) : null}

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) setDeleteTarget(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {itemLabel} “{deleteTarget?.name}”?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.scope === "project"
                ? `Removes the project ${itemLabel} from the project's .omp folder.`
                : `Removes the global ${itemLabel} file from the omp agent directory.`}
              {deleteTarget?.scope === "project" && deleteTarget && " This cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={deleting} />}>
              Cancel
            </AlertDialogClose>
            <Button variant="destructive" disabled={deleting} onClick={() => void confirmDelete()}>
              {deleting ? (
                <LoaderIcon className="size-3.5 animate-spin" />
              ) : (
                <Trash2Icon className="size-3.5" />
              )}
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsPageContainer>
  );
}
