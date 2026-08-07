import { AuthOrchestrationReadScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { annotateEnvironmentRequest, requireEnvironmentScope } from "../auth/http.ts";
import * as UsageService from "./UsageService.ts";

/**
 * Usage is read-only reporting over data the host already has, so it rides the
 * orchestration read scope rather than introducing a new one.
 */
export const usageHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "usage",
  Effect.fnUntraced(function* (handlers) {
    const usage = yield* UsageService.UsageService;

    return handlers.handle(
      "snapshot",
      Effect.fn("environment.usage.snapshot")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        yield* requireEnvironmentScope(AuthOrchestrationReadScope);
        return yield* usage.getSnapshot(args.payload.sinceDate);
      }),
    );
  }),
);
