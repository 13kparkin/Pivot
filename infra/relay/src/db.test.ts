import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import * as RelayDb from "./db.ts";
import { relayEnvironmentLifecycleLeases } from "./persistence/schema.ts";

it.effect("leases lifecycle work without changing its transaction boundary", () => {
  const calls: Array<string> = [];
  let ownerId = "";
  const db = {
    $client: {
      withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.sync(() => {
          calls.push("transaction");
        }).pipe(Effect.andThen(effect)),
    },
    insert: (table: unknown) => {
      expect(table).toBe(relayEnvironmentLifecycleLeases);
      return {
        values: (values: { readonly ownerId: string }) => {
          ownerId = values.ownerId;
          calls.push("acquire");
          return {
            onConflictDoUpdate: () => ({
              returning: () => Effect.succeed([{ ownerId }]),
            }),
          };
        },
      };
    },
    delete: (table: unknown) => {
      expect(table).toBe(relayEnvironmentLifecycleLeases);
      return {
        where: () =>
          Effect.sync(() => {
            calls.push("release");
          }),
      };
    },
  } as unknown as RelayDb.RelayDb["Service"];
  const layer = RelayDb.RelayTransactions.layer.pipe(
    Layer.provide(Layer.succeed(RelayDb.RelayDb, db)),
  );

  return Effect.gen(function* () {
    const transactions = yield* RelayDb.RelayTransactions;
    const result = yield* Effect.result(
      transactions.withEnvironmentLock(
        { userId: "user-1", environmentId: "environment-1" },
        Effect.sync(() => {
          calls.push("work");
        }).pipe(Effect.andThen(Effect.fail("expected failure" as const))),
      ),
    );

    expect(Result.isFailure(result)).toBe(true);
    expect(ownerId).not.toBe("");
    expect(calls).toEqual(["acquire", "work", "release"]);
  }).pipe(Effect.provide(layer));
});
