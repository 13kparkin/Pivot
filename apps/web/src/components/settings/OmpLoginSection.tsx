"use client";

import { LoaderIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  type EnvironmentId,
  type OmpLoginProvider,
  type ProviderInstanceId,
} from "@t3tools/contracts";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";

export function OmpLoginSection(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
}) {
  const listLoginProviders = useAtomCommand(serverEnvironment.ompListLoginProviders, {
    label: "omp-list-login-providers",
  });
  const ompLogin = useAtomCommand(serverEnvironment.ompLogin, {
    label: "omp-login",
  });
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    label: "omp-login-refresh-providers",
  });

  const [providers, setProviders] = useState<ReadonlyArray<OmpLoginProvider>>([]);
  const [loading, setLoading] = useState(true);
  const [loggingInId, setLoggingInId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    const result = await listLoginProviders({
      environmentId: props.environmentId,
      input: { instanceId: props.instanceId },
    });
    setLoading(false);
    if (result._tag === "Failure") {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not load omp login providers",
          description: "Check that omp is installed and try again.",
        }),
      );
      return;
    }
    setProviders(result.value.providers);
  }, [listLoginProviders, props.environmentId, props.instanceId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const startLogin = async (providerId: string) => {
    setLoggingInId(providerId);
    const result = await ompLogin({
      environmentId: props.environmentId,
      input: { providerId, instanceId: props.instanceId },
    });
    setLoggingInId(null);
    if (result._tag === "Failure") {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Login failed for ${providerId}`,
          description:
            "Complete login in the browser opened on the server host, or run omp login there.",
        }),
      );
      return;
    }
    toastManager.add({
      type: "success",
      title: `Signed in to ${providerId}`,
    });
    await refreshProviders({
      environmentId: props.environmentId,
      input: { instanceId: props.instanceId },
    });
    await reload();
  };

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-foreground">omp accounts</span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 px-2 text-xs"
          disabled={loading || loggingInId !== null}
          onClick={() => void reload()}
        >
          Refresh
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Login opens in a browser on the machine running the T3 server. OAuth callbacks stay on that
        host.
      </p>
      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <LoaderIcon className="size-3.5 animate-spin" />
          Loading login providers…
        </div>
      ) : providers.length === 0 ? (
        <p className="text-xs text-muted-foreground">No login providers reported by omp.</p>
      ) : (
        <ul className="grid max-h-64 gap-1.5 overflow-y-auto">
          {providers.map((provider) => (
            <li
              key={provider.id}
              className="flex items-center justify-between gap-2 rounded-md border border-border/60 px-2 py-1.5"
            >
              <div className="min-w-0">
                <div className="truncate text-xs font-medium text-foreground">{provider.name}</div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {provider.authenticated ? "Signed in" : "Not signed in"}
                  {provider.available ? "" : " · unavailable"}
                </div>
              </div>
              <Button
                type="button"
                size="sm"
                variant={provider.authenticated ? "outline" : "default"}
                className="h-7 shrink-0 px-2 text-xs"
                disabled={!provider.available || loggingInId !== null}
                onClick={() => void startLogin(provider.id)}
              >
                {loggingInId === provider.id ? (
                  <LoaderIcon className="size-3.5 animate-spin" />
                ) : provider.authenticated ? (
                  "Re-login"
                ) : (
                  "Login"
                )}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
