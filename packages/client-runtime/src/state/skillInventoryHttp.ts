import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeEnvironmentHttpRequest, makeEnvironmentHttpApiClient } from "../rpc/http.ts";
import { buildEnvironmentAuthHeaders, withEnvironmentCredentials } from "./environmentHttpAuth.ts";

const DEFAULT_SKILL_INVENTORY_TIMEOUT_MS = 10_000;

export const fetchEnvironmentSkillInventory = Effect.fn(
  "clientRuntime.state.fetchEnvironmentSkillInventory",
)(function* (input: { readonly prepared: PreparedConnection; readonly timeoutMs?: number }) {
  const requestUrl = environmentEndpointUrl(input.prepared.httpBaseUrl, "/api/skills");
  const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const headers = yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "GET",
    requestUrl,
    Option.isSome(signer) ? signer : Option.none(),
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_SKILL_INVENTORY_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      client.skills.inventory({ headers }),
    ),
  );
});
