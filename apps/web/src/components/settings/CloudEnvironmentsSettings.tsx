import { CheckIcon, CloudIcon, CopyIcon, ExternalLinkIcon, LoaderCircleIcon } from "lucide-react";
import { connectionStatusText } from "@t3tools/client-runtime/connection";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useMemo, useState } from "react";

import { cloudEnvironmentProvider } from "~/cloud/cloudEnvironment";
import { openCommandPalette } from "~/commandPaletteBus";
import { environmentCatalog } from "~/connection/catalog";
import { connectPairing as connectPairingAtom } from "~/connection/onboarding";
import { readHostedPairingRequest } from "~/hostedPairing";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { getPairingTokenFromUrl } from "~/pairingUrl";
import { useAtomCommand } from "~/state/use-atom-command";
import { type EnvironmentPresentation, useEnvironments } from "~/state/environments";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const RENDER_DEPLOY_URL =
  "https://dashboard.render.com/blueprint/new?repo=https%3A%2F%2Fgithub.com%2Fpingdotgg%2Ft3code&branch=feat%2Frender-cloud-environment";
const CODEX_LOGIN_COMMAND = "codex login --device-auth";

function pairingInput(value: string): { readonly host: string; readonly pairingCode: string } {
  const url = new URL(value.trim());
  const hostedRequest = readHostedPairingRequest(url);
  if (hostedRequest) {
    return { host: hostedRequest.host, pairingCode: hostedRequest.token };
  }
  const pairingCode = getPairingTokenFromUrl(url);
  if (!pairingCode) {
    throw new Error("Paste the full Pair URL from the Render logs.");
  }
  return { host: url.origin, pairingCode };
}

function CopyCommand({ command }: { readonly command: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "command" });
  return (
    <div className="mt-2 flex min-w-0 items-start gap-2 rounded-lg border border-border/70 bg-muted/20 p-2">
      <code className="min-w-0 flex-1 overflow-x-auto py-1 text-xs text-foreground">{command}</code>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Copy command"
        onClick={() => copyToClipboard(command, undefined)}
      >
        {isCopied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      </Button>
    </div>
  );
}

function RenderEnvironmentRow({
  environment,
  busyEnvironmentId,
  onConnect,
  onDisconnect,
}: {
  readonly environment: EnvironmentPresentation;
  readonly busyEnvironmentId: EnvironmentId | null;
  readonly onConnect: (environmentId: EnvironmentId) => void;
  readonly onDisconnect: (environmentId: EnvironmentId) => void;
}) {
  const isConnected = environment.connection.phase === "connected";
  const isBusy = busyEnvironmentId === environment.environmentId;
  return (
    <SettingsRow
      title={environment.label}
      description="Powered by Render"
      status={connectionStatusText(environment.connection)}
      control={
        <>
          {isConnected ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() => openCommandPalette({ open: "add-project" })}
            >
              Add project
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="outline"
            disabled={isBusy}
            onClick={() =>
              isConnected
                ? onDisconnect(environment.environmentId)
                : onConnect(environment.environmentId)
            }
          >
            {isBusy ? <LoaderCircleIcon className="size-3 animate-spin" /> : null}
            {isConnected ? "Disconnect" : "Connect"}
          </Button>
        </>
      }
    />
  );
}

export function CloudEnvironmentsSettings() {
  const { environments } = useEnvironments();
  const connectPairing = useAtomCommand(connectPairingAtom, { reportFailure: false });
  const retryEnvironment = useAtomCommand(environmentCatalog.retryNow, { reportFailure: false });
  const removeEnvironment = useAtomCommand(environmentCatalog.remove, { reportFailure: false });
  const [pairUrl, setPairUrl] = useState("");
  const [pairing, setPairing] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);
  const [busyEnvironmentId, setBusyEnvironmentId] = useState<EnvironmentId | null>(null);
  const renderEnvironments = useMemo(
    () => environments.filter((environment) => cloudEnvironmentProvider(environment) === "render"),
    [environments],
  );
  const hasConnectedRenderEnvironment = renderEnvironments.some(
    (environment) => environment.connection.phase === "connected",
  );

  const reportFailure = useCallback((title: string, description: string) => {
    toastManager.add(stackedThreadToast({ type: "error", title, description }));
  }, []);

  const handlePair = useCallback(async () => {
    setPairError(null);
    let input: ReturnType<typeof pairingInput>;
    try {
      input = pairingInput(pairUrl);
    } catch (error) {
      setPairError(error instanceof Error ? error.message : "Invalid Pair URL.");
      return;
    }
    setPairing(true);
    const result = await connectPairing(input);
    setPairing(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setPairError(failure instanceof Error ? failure.message : "Could not pair environment.");
      }
      return;
    }
    setPairUrl("");
    toastManager.add({ type: "success", title: "Render environment connected" });
  }, [connectPairing, pairUrl]);

  const handleConnect = useCallback(
    async (environmentId: EnvironmentId) => {
      setBusyEnvironmentId(environmentId);
      const result = await retryEnvironment(environmentId);
      setBusyEnvironmentId(null);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        reportFailure(
          "Could not connect Render environment",
          failure instanceof Error ? failure.message : "Could not connect Render environment.",
        );
      }
    },
    [reportFailure, retryEnvironment],
  );

  const handleDisconnect = useCallback(
    async (environmentId: EnvironmentId) => {
      setBusyEnvironmentId(environmentId);
      const result = await removeEnvironment(environmentId);
      setBusyEnvironmentId(null);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        reportFailure(
          "Could not disconnect Render environment",
          failure instanceof Error ? failure.message : "Could not disconnect Render environment.",
        );
      }
    },
    [removeEnvironment, reportFailure],
  );

  return (
    <SettingsPageContainer>
      <SettingsSection
        {...searchableSetting("cloud-environments")}
        icon={<CloudIcon className="size-4" />}
      >
        <SettingsRow
          title="Powered by Render"
          description="Creates a temporary free cloud machine for the demo."
          control={
            <Button
              size="sm"
              render={<a href={RENDER_DEPLOY_URL} target="_blank" rel="noreferrer" />}
            >
              Deploy on Render
              <ExternalLinkIcon className="size-3.5" />
            </Button>
          }
        />
      </SettingsSection>

      <SettingsSection title="Connect">
        <SettingsRow
          title="Pair URL"
          description="Connects this T3 Code client to the cloud machine. Copy the URL from the Render logs."
        >
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <Input
              value={pairUrl}
              onChange={(event) => setPairUrl(event.target.value)}
              placeholder="https://app.t3.codes/pair?host=..."
              onKeyDown={(event) => {
                if (event.key === "Enter") void handlePair();
              }}
            />
            <Button
              disabled={pairing || pairUrl.trim().length === 0}
              onClick={() => void handlePair()}
            >
              {pairing ? <LoaderCircleIcon className="size-4 animate-spin" /> : null}
              Pair environment
            </Button>
          </div>
          {pairError ? <p className="mt-2 text-xs text-destructive">{pairError}</p> : null}
        </SettingsRow>
        {renderEnvironments.map((environment) => (
          <RenderEnvironmentRow
            key={environment.environmentId}
            environment={environment}
            busyEnvironmentId={busyEnvironmentId}
            onConnect={(environmentId) => void handleConnect(environmentId)}
            onDisconnect={(environmentId) => void handleDisconnect(environmentId)}
          />
        ))}
      </SettingsSection>

      <SettingsSection title="Ready to use">
        <SettingsRow
          title="Get the code"
          description="Choose Render and paste a public GitHub URL. The repository is cloned inside the cloud machine."
          control={
            <Button
              size="sm"
              disabled={!hasConnectedRenderEnvironment}
              onClick={() => openCommandPalette({ open: "add-project" })}
            >
              Add project
            </Button>
          }
        />
        <SettingsRow
          title="Authenticate Codex"
          description="After cloning, open that project's terminal and run this once. Then start an agent."
          status="Free instances forget this login when they restart or spin down."
        >
          <CopyCommand command={CODEX_LOGIN_COMMAND} />
        </SettingsRow>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
