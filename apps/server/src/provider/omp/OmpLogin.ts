/**
 * Short-lived omp RPC probe helpers for Settings login / auth listing.
 *
 * @module provider/omp/OmpLogin
 */
import { ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { OmpAdapter, OmpLoginProvider, OmpOpenUrlRequest } from "./OmpAdapter.ts";

const PROVIDER = ProviderDriverKind.make("omp");

export function listOmpLoginProviders(input: {
  readonly adapter: OmpAdapter;
  readonly randomUUID: Effect.Effect<string>;
  readonly cwd: string;
}): Effect.Effect<ReadonlyArray<OmpLoginProvider>, unknown> {
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
  }).pipe(Effect.scoped);
}

export function loginOmpProvider(input: {
  readonly adapter: OmpAdapter;
  readonly randomUUID: Effect.Effect<string>;
  readonly cwd: string;
  readonly providerId: string;
  readonly onOpenUrl: (request: OmpOpenUrlRequest) => Effect.Effect<void>;
}): Effect.Effect<{ readonly providerId: string }, unknown> {
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
  }).pipe(Effect.scoped);
}
