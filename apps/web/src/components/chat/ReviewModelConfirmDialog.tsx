"use client";

import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Button } from "../ui/button";

/**
 * Confirmation shown before starting a review that would use the default model
 * (no `review` role configured). Names the model it would fall back to. The
 * user can proceed with the default, cancel, or jump to the Models & Roles page
 * to set a dedicated model first.
 */
export function ReviewModelConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  onSetModel,
  defaultModelLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  onSetModel: () => void;
  defaultModelLabel: string | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Use your default model?</DialogTitle>
        </DialogHeader>
        <DialogDescription>
          No review model is set, so this review will run on your current model
          {defaultModelLabel ? (
            <>
              {" "}
              — <span className="font-medium text-foreground">{defaultModelLabel}</span>
            </>
          ) : null}
          . You can proceed with it, or set a dedicated review model under Settings → Capabilities →
          Models &amp; Roles first.
        </DialogDescription>
        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onSetModel}>
            Set review model
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              onOpenChange(false);
              onConfirm();
            }}
          >
            Use default
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
