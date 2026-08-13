import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { KeyboardController } from "react-native-keyboard-controller";

import type { ComposerEditorHandle } from "../../components/ComposerEditor";

type PresentationPhase = "closed" | "opening" | "visible" | "closing";

/**
 * Keeps the custom native composer and the settings sheet from owning focus at
 * the same time. Keyboard and sheet transitions overlap in both directions,
 * while cancelled interactive dismissals return ownership to the sheet.
 */
export function useThreadSettingsSheetPresentation(input: {
  readonly editorRef: RefObject<ComposerEditorHandle | null>;
  readonly isEditorFocused: boolean;
  /**
   * Native-stack sheets can hide the keyboard without resigning the editor.
   * Keeping that first responder lets UIKit restore the same keyboard during
   * an interactive dismissal instead of polling until the modal is gone.
   */
  readonly keepEditorFocused?: boolean;
}) {
  const [phase, setPhase] = useState<PresentationPhase>("closed");
  const isActiveRef = useRef(false);
  const isMountedRef = useRef(true);
  const isEditorFocusedRef = useRef(input.isEditorFocused);
  const openingIdRef = useRef(0);
  const focusRestoreIdRef = useRef(0);
  const restoreFocusAfterDismissRef = useRef(false);

  useEffect(() => {
    isEditorFocusedRef.current = input.isEditorFocused;
  }, [input.isEditorFocused]);

  useEffect(() => {
    // React Strict Mode and Fast Refresh both run an effect cleanup/setup
    // cycle without recreating refs. Re-arm the mounted guard on every setup.
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      isActiveRef.current = false;
      openingIdRef.current += 1;
      focusRestoreIdRef.current += 1;
    };
  }, []);

  const open = useCallback(() => {
    if (isActiveRef.current) {
      return;
    }

    isActiveRef.current = true;
    focusRestoreIdRef.current += 1;
    restoreFocusAfterDismissRef.current = input.isEditorFocused || KeyboardController.isVisible();
    setPhase("opening");

    const openingId = openingIdRef.current + 1;
    openingIdRef.current = openingId;

    // Start the keyboard transition before the custom native editor resigns
    // first responder, then present the sheet on the next frame. The sheet and
    // keyboard animate together instead of serializing two native transitions.
    void KeyboardController.dismiss({
      animated: true,
      keepFocus: input.keepEditorFocused && restoreFocusAfterDismissRef.current,
    });
    if (!input.keepEditorFocused) {
      input.editorRef.current?.blur();
    }

    requestAnimationFrame(() => {
      if (!isMountedRef.current || !isActiveRef.current || openingIdRef.current !== openingId) {
        return;
      }
      setPhase("visible");
    });
  }, [input.editorRef, input.isEditorFocused, input.keepEditorFocused]);

  const close = useCallback(() => {
    if (!isActiveRef.current) {
      return;
    }

    openingIdRef.current += 1;
    setPhase("closing");
  }, []);

  const restoreEditorFocus = useCallback(() => {
    if (input.keepEditorFocused) {
      KeyboardController.setFocusTo("current");
      return;
    }

    const focusRestoreId = focusRestoreIdRef.current + 1;
    focusRestoreIdRef.current = focusRestoreId;
    let attemptsRemaining = 20;

    // A native-stack button pop reveals the draft before UIKit has fully
    // removed the form sheet. Retry until the editor confirms focus; a
    // swipe dismissal normally succeeds on the first attempt.
    const restoreFocus = () => {
      if (
        !isMountedRef.current ||
        focusRestoreIdRef.current !== focusRestoreId ||
        isEditorFocusedRef.current ||
        attemptsRemaining <= 0
      ) {
        return;
      }

      attemptsRemaining -= 1;
      input.editorRef.current?.focus();
      setTimeout(restoreFocus, 50);
    };
    requestAnimationFrame(restoreFocus);
  }, [input.editorRef, input.keepEditorFocused]);

  const beginDismissalFocusRestore = useCallback(() => {
    if (restoreFocusAfterDismissRef.current) {
      restoreEditorFocus();
    }
  }, [restoreEditorFocus]);

  const cancelDismissalFocusRestore = useCallback(() => {
    focusRestoreIdRef.current += 1;
    if (!input.keepEditorFocused) {
      input.editorRef.current?.blur();
    }
    void KeyboardController.dismiss({
      animated: true,
      keepFocus: input.keepEditorFocused && restoreFocusAfterDismissRef.current,
    });
  }, [input.editorRef, input.keepEditorFocused]);

  const onDismissed = useCallback(() => {
    const shouldRestoreFocus = restoreFocusAfterDismissRef.current;
    restoreFocusAfterDismissRef.current = false;
    isActiveRef.current = false;
    setPhase("closed");

    if (shouldRestoreFocus) {
      // Also start here as a fallback for dismissal paths that don't emit a
      // native transition-start event to the underlying route.
      restoreEditorFocus();
    }
  }, [restoreEditorFocus]);

  // The new-task screen can have an autofocus queued before the sheet opens.
  // Preserve that intent without allowing it to focus under the sheet.
  const requestFocusAfterDismiss = useCallback(() => {
    if (isActiveRef.current) {
      restoreFocusAfterDismissRef.current = true;
    }
  }, []);

  return {
    isActive: phase !== "closed",
    isActiveRef,
    isVisible: phase === "visible",
    open,
    close,
    onDismissed,
    beginDismissalFocusRestore,
    cancelDismissalFocusRestore,
    requestFocusAfterDismiss,
  } as const;
}
