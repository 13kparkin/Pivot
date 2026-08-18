/**
 * Short-lived omp RPC probe helpers for Settings login / auth listing.
 *
 * @module provider/omp/OmpLogin
 */
import { ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import type { OmpAdapter, OmpOpenUrlRequest } from "./OmpAdapter.ts";
import type { OmpLoginProvider } from "./OmpCatalogDecoder.ts";

const PROVIDER = ProviderDriverKind.make("omp");

export class OmpLoginError extends Data.TaggedError("OmpLoginError")<{
  readonly message: string;
}> {}

export function toOmpLoginError(cause: unknown): OmpLoginError {
  if (cause instanceof OmpLoginError) {
    return cause;
  }
  if (cause instanceof Error) {
    return new OmpLoginError({ message: cause.message });
  }
  return new OmpLoginError({ message: String(cause) });
}

export function listOmpLoginProviders(input: {
  readonly adapter: OmpAdapter;
  readonly randomUUID: Effect.Effect<string>;
  readonly cwd: string;
}): Effect.Effect<ReadonlyArray<OmpLoginProvider>, OmpLoginError> {
  return Effect.gen(function* () {
    const probeId = yield* input.randomUUID;
    const threadId = ThreadId.make(`omp-login-list-${probeId}`);
    yield* input.adapter.startSession({
      threadId,
      provider: PROVIDER,
      cwd: input.cwd,
      runtimeMode: "full-access",
    });
    return yield* input.adapter
      .listLoginProviders(threadId)
      .pipe(Effect.ensuring(input.adapter.stopSession(threadId)));
  }).pipe(Effect.scoped, Effect.mapError(toOmpLoginError));
}

export function loginOmpProvider(input: {
  readonly adapter: OmpAdapter;
  readonly randomUUID: Effect.Effect<string>;
  readonly cwd: string;
  readonly providerId: string;
  readonly onOpenUrl: (request: OmpOpenUrlRequest) => Effect.Effect<void>;
}): Effect.Effect<{ readonly providerId: string }, OmpLoginError> {
  return Effect.gen(function* () {
    const probeId = yield* input.randomUUID;
    const threadId = ThreadId.make(`omp-login-${probeId}`);
    yield* input.adapter.startSession({
      threadId,
      provider: PROVIDER,
      cwd: input.cwd,
      runtimeMode: "full-access",
    });
    return yield* input.adapter
      .login(threadId, input.providerId, input.onOpenUrl)
      .pipe(Effect.ensuring(input.adapter.stopSession(threadId)));
  }).pipe(Effect.scoped, Effect.mapError(toOmpLoginError));
}
