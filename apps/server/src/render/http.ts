import * as NodeCrypto from "node:crypto";
import {
  EnvironmentHttpApi,
  EnvironmentHttpForbiddenError,
  EnvironmentHttpInternalServerError,
  EnvironmentHttpUnauthorizedError,
} from "@t3tools/contracts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import { HttpServerResponse } from "effect/unstable/http";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";

const RENDER_BOOTSTRAP_RESPONSE_HEADERS = {
  "cache-control": "no-store",
  pragma: "no-cache",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} as const;

export function renderSetupCodeMatches(expected: string, candidate: string): boolean {
  const expectedDigest = NodeCrypto.createHash("sha256").update(expected).digest();
  const candidateDigest = NodeCrypto.createHash("sha256").update(candidate).digest();
  return NodeCrypto.timingSafeEqual(expectedDigest, candidateDigest);
}

const appendRenderBootstrapResponseHeaders = HttpEffect.appendPreResponseHandler(
  (_request, response) =>
    Effect.succeed(HttpServerResponse.setHeaders(response, RENDER_BOOTSTRAP_RESPONSE_HEADERS)),
);

export const renderBootstrapHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "renderBootstrap",
  Effect.fnUntraced(function* (handlers) {
    const hostEnvironment = yield* HostProcessEnvironment;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const configuredProvider = hostEnvironment.T3CODE_CLOUD_PROVIDER?.trim().toLowerCase();
    const configuredSetupCode = hostEnvironment.T3CODE_RENDER_SETUP_CODE?.trim() ?? "";
    const environmentLabel =
      hostEnvironment.T3CODE_ENVIRONMENT_LABEL?.trim() || "Render cloud environment";
    delete hostEnvironment.T3CODE_RENDER_SETUP_CODE;

    return handlers.handle(
      "pair",
      Effect.fn("environment.renderBootstrap.pair")(function* ({ payload }) {
        yield* appendRenderBootstrapResponseHeaders;
        if (configuredProvider !== "render" || configuredSetupCode.length === 0) {
          return yield* new EnvironmentHttpForbiddenError({
            message: "This environment is not configured for Render setup.",
          });
        }
        if (!renderSetupCodeMatches(configuredSetupCode, payload.setupCode)) {
          return yield* new EnvironmentHttpUnauthorizedError({
            message: "The Render setup code is invalid.",
          });
        }

        const issued = yield* serverAuth.issuePairingCredential({ label: "Render setup" }).pipe(
          Effect.mapError(
            () =>
              new EnvironmentHttpInternalServerError({
                message: "Could not create a Render pairing credential.",
              }),
          ),
        );
        return {
          pairingCode: issued.credential,
          label: environmentLabel,
        };
      }),
    );
  }),
);
