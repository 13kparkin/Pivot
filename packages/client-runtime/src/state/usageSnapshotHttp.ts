import type { EnvironmentUsageSnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import type { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import {
  executeEnvironmentHttpRequest,
  makeEnvironmentHttpApiClient,
  type RemoteEnvironmentRequestError,
} from "../rpc/http.ts";
import { buildEnvironmentAuthHeaders, withEnvironmentCredentials } from "./environmentHttpAuth.ts";

/**
 * Scanning a host's agent session logs is disk-bound and can take seconds on a
 * machine with a long history, so this allows considerably more time than the
 * interactive snapshot fetches.
 */
const DEFAULT_USAGE_SNAPSHOT_TIMEOUT_MS = 30_000;

/**
 * Read one environment's usage snapshot over HTTP, authenticated with whatever
 * credential that connection was prepared with (cookie, bearer, or DPoP).
 *
 * Each host owns the agent logs its own runs wrote, so a usage page covering
 * several environments calls this once per environment and merges the results.
 */
export const fetchEnvironmentUsageSnapshot = Effect.fn(
  "clientRuntime.state.fetchEnvironmentUsageSnapshot",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly sinceDate: string;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly timeoutMs?: number;
}) {
  const requestUrl = environmentEndpointUrl(input.prepared.httpBaseUrl, "/api/usage/snapshot");
  const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
  const headers = yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "GET",
    requestUrl,
    input.signer,
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_USAGE_SNAPSHOT_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      client.usage.snapshot({ payload: { sinceDate: input.sinceDate }, headers }),
    ),
  );
});

export type FetchEnvironmentUsageSnapshotError = RemoteEnvironmentRequestError;
export type FetchedEnvironmentUsageSnapshot = EnvironmentUsageSnapshot;
