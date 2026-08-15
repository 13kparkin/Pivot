"use client";

import type { EnvironmentId, OmpCapabilityScope, ProjectId } from "@t3tools/contracts";
import { BracesIcon, ExternalLinkIcon, LoaderIcon, SaveIcon } from "lucide-react";
import { useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";

import type { CapabilitiesSettingsRow } from "./CapabilitiesSettingsPanel";
import { buildWriteSettingInput, parseSettingDraft } from "./CapabilitiesSettingsPanel.logic";

/** omp settings documentation. */
const OMP_CONFIG_DOCS_URL = "https://omp.sh/docs/";

interface CapabilitiesSettingDialogProps {
  readonly entry: CapabilitiesSettingsRow;
  readonly scope: OmpCapabilityScope;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onMutated: () => void;
}

/**
 * Modal editor for a record/array omp config setting: the value is edited as
 * JSON in a textarea (validated before the write), with a link to the omp
 * config docs and a Format action that pretty-prints the draft.
 */
export function CapabilitiesSettingDialog({
  entry,
  scope,
  environmentId,
  projectId,
  onOpenChange,
  onMutated,
}: CapabilitiesSettingDialogProps) {
  const [draft, setDraft] = useState(() => formatSettingValue(entry.value));
  const [draftError, setDraftError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const writeSetting = useAtomCommand(serverEnvironment.capabilitiesWriteSetting, {
    label: "capabilities-write-setting",
  });

  const save = async () => {
    setBusy(true);
    const parsed = parseSettingDraft(entry.type, draft);
    if (!parsed.ok) {
      setDraftError(parsed.error);
      setBusy(false);
      return;
    }
    const result = await writeSetting({
      environmentId,
      input: buildWriteSettingInput({ key: entry.key, value: parsed.value, scope, projectId }),
    });
    setBusy(false);
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
    onOpenChange(false);
  };

  const formatDraft = () => {
    try {
      setDraft(JSON.stringify(JSON.parse(draft), null, 2));
      setDraftError(null);
    } catch {
      setDraftError("Value is not valid JSON.");
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="font-mono text-base">{entry.key}</DialogTitle>
        </DialogHeader>
        <div
          data-slot="dialog-panel"
          className="space-y-4 p-6 in-[[data-slot=dialog-popup]:has([data-slot=dialog-header])]:pt-1"
        >
          <div className="rounded-md border border-border/70 bg-muted/30 px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
                Documentation
              </p>
              <a
                href={OMP_CONFIG_DOCS_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-foreground/80 underline-offset-2 hover:underline"
              >
                Config docs
                <ExternalLinkIcon className="size-3" aria-hidden />
              </a>
            </div>
            {entry.description.length > 0 ? (
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {entry.description}
              </p>
            ) : null}
          </div>
          <div>
            <div className="flex items-center justify-between gap-2">
              <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
                Value
              </p>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                onClick={formatDraft}
              >
                <BracesIcon className="size-3" aria-hidden />
                Format
              </Button>
            </div>
            <Textarea
              className="mt-1.5 min-h-24 font-mono text-xs"
              value={draft}
              onChange={(event) => {
                setDraft(event.currentTarget.value);
                setDraftError(null);
              }}
              placeholder="Unset"
              spellCheck={false}
              aria-label={`Value for ${entry.key}`}
            />
          </div>
          {draftError !== null ? <p className="text-xs text-destructive">{draftError}</p> : null}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="button" size="sm" disabled={busy} onClick={() => void save()}>
            {busy ? (
              <LoaderIcon className="size-3.5 animate-spin" />
            ) : (
              <SaveIcon className="size-3.5" />
            )}
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * Pretty-print records/arrays (2-space indent) so the modal opens with a
 * readable value; primitives render verbatim.
 */
function formatSettingValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  return String(value);
}
