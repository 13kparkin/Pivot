import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { KeyboardController } from "react-native-keyboard-controller";

import type { ComposerEditorHandle } from "../../components/ComposerEditor";

export type ThreadSettingsSheetCloseReason = "save" | "dismiss";

type PresentationPhase = "closed" | "opening" | "visible" | "closing";

/**
 * Keeps the custom native composer and the settings modal from owning focus at
 * the same time. Opening waits for the keyboard dismissal to finish, while
 * focus restoration waits for the modal's dismissal callback.
 */
export function useThreadSettingsSheetPresentation(input: {
  readonly editorRef: RefObject<ComposerEditorHandle | null>;
  readonly isEditorFocused: boolean;
}) {
  const [phase, setPhase] = useState<PresentationPhase>("closed");
  const isActiveRef = useRef(false);
  const isMountedRef = useRef(true);
  const openingIdRef = useRef(0);
  const restoreFocusOnSaveRef = useRef(false);
  const shouldRestoreAfterDismissRef = useRef(false);

  useEffect(() => {
    // React Strict Mode and Fast Refresh both run an effect cleanup/setup
    // cycle without recreating refs. Re-arm the mounted guard on every setup.
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      isActiveRef.current = false;
      openingIdRef.current += 1;
    };
  }, []);

  const open = useCallback(() => {
    if (isActiveRef.current) {
      return;
    }

    isActiveRef.current = true;
    restoreFocusOnSaveRef.current = input.isEditorFocused || KeyboardController.isVisible();
    shouldRestoreAfterDismissRef.current = false;
    setPhase("opening");

    const openingId = openingIdRef.current + 1;
    openingIdRef.current = openingId;

    // Start observing the keyboard transition before the custom native editor
    // resigns first responder. Blurring first can finish the dismissal before
    // KeyboardController subscribes, leaving this promise pending forever.
    const keyboardDismissal = KeyboardController.dismiss({ animated: false });
    input.editorRef.current?.blur();
    void keyboardDismissal.then(() => {
      if (!isMountedRef.current || !isActiveRef.current || openingIdRef.current !== openingId) {
        return;
      }
      setPhase("visible");
    });
  }, [input.editorRef, input.isEditorFocused]);

  const close = useCallback((reason: ThreadSettingsSheetCloseReason) => {
    if (!isActiveRef.current) {
      return;
    }

    openingIdRef.current += 1;
    shouldRestoreAfterDismissRef.current = reason === "save" && restoreFocusOnSaveRef.current;
    setPhase("closing");
  }, []);

  const onDismissed = useCallback(() => {
    const shouldRestoreFocus = shouldRestoreAfterDismissRef.current;
    shouldRestoreAfterDismissRef.current = false;
    restoreFocusOnSaveRef.current = false;
    isActiveRef.current = false;
    setPhase("closed");

    if (shouldRestoreFocus) {
      input.editorRef.current?.focus();
    }
  }, [input.editorRef]);

  // The new-task screen can have an autofocus queued before the sheet opens.
  // Preserve that intent for Save without allowing it to focus under the modal.
  const restoreFocusAfterSave = useCallback(() => {
    if (isActiveRef.current) {
      restoreFocusOnSaveRef.current = true;
    }
  }, []);

  return {
    isActive: phase !== "closed",
    isActiveRef,
    isVisible: phase === "visible",
    open,
    close,
    onDismissed,
    restoreFocusAfterSave,
  } as const;
}
