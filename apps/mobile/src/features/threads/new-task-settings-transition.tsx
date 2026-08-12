import { createContext, use, useCallback, useMemo, useRef, type ReactNode } from "react";

type TransitionHandlers = {
  readonly onDismissalCancel: () => void;
  readonly onDismissalStart: () => void;
};

type NewTaskSettingsTransitionValue = {
  readonly notifyDismissalCancel: () => void;
  readonly notifyDismissalStart: () => void;
  readonly registerHandlers: (handlers: TransitionHandlers) => () => void;
};

const NewTaskSettingsTransitionContext = createContext<NewTaskSettingsTransitionValue | null>(null);

/** Shares the child sheet's native transition events with the draft editor. */
export function NewTaskSettingsTransitionProvider(props: { readonly children: ReactNode }) {
  const handlersRef = useRef<TransitionHandlers | null>(null);
  const registerHandlers = useCallback((handlers: TransitionHandlers) => {
    handlersRef.current = handlers;
    return () => {
      if (handlersRef.current === handlers) {
        handlersRef.current = null;
      }
    };
  }, []);
  const notifyDismissalStart = useCallback(() => handlersRef.current?.onDismissalStart(), []);
  const notifyDismissalCancel = useCallback(() => handlersRef.current?.onDismissalCancel(), []);
  const value = useMemo(
    () => ({ notifyDismissalCancel, notifyDismissalStart, registerHandlers }),
    [notifyDismissalCancel, notifyDismissalStart, registerHandlers],
  );

  return (
    <NewTaskSettingsTransitionContext.Provider value={value}>
      {props.children}
    </NewTaskSettingsTransitionContext.Provider>
  );
}

export function useNewTaskSettingsTransition() {
  const value = use(NewTaskSettingsTransitionContext);
  if (!value) {
    throw new Error("useNewTaskSettingsTransition must be used inside its transition provider.");
  }
  return value;
}
