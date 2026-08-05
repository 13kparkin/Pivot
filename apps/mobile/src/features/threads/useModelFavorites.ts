import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";
import { AsyncResult } from "effect/unstable/reactivity";

import type { ModelOption } from "../../lib/modelOptions";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

/** Persists model favorites on this device without inventing a server setting. */
export function useModelFavorites(environmentId: EnvironmentId | null) {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const storedKeys = AsyncResult.isSuccess(preferencesResult)
    ? (preferencesResult.value.favoriteModelKeys ?? [])
    : [];
  const environmentPrefix = environmentId === null ? null : `${environmentId}:`;

  const favoriteModelKeys = useMemo(() => {
    if (environmentPrefix === null) return new Set<string>();
    return new Set(
      storedKeys.flatMap((key) =>
        key.startsWith(environmentPrefix) ? [key.slice(environmentPrefix.length)] : [],
      ),
    );
  }, [environmentPrefix, storedKeys]);

  const toggleFavorite = useCallback(
    (option: ModelOption) => {
      if (environmentPrefix === null) return;
      const scopedKey = `${environmentPrefix}${option.key}`;
      const nextKeys = storedKeys.includes(scopedKey)
        ? storedKeys.filter((key) => key !== scopedKey)
        : [...storedKeys, scopedKey];
      savePreferences({ favoriteModelKeys: nextKeys });
    },
    [environmentPrefix, savePreferences, storedKeys],
  );

  return { favoriteModelKeys, toggleFavorite };
}
