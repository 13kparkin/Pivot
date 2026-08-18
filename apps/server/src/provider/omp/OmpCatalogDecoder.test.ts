import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe } from "vite-plus/test";

import { ProviderAdapterRequestError } from "../Errors.ts";
import { OmpCatalogDecoder } from "./OmpCatalogDecoder.ts";

const isProviderAdapterRequestError = Schema.is(ProviderAdapterRequestError);

class CatalogRpcFixture {
  static model(overrides: Record<string, unknown> = {}) {
    return { provider: "openai", id: "gpt-5", name: "GPT-5", ...overrides };
  }

  static modelsResponse(
    entries: ReadonlyArray<Record<string, unknown>> = [CatalogRpcFixture.model()],
  ) {
    return { data: { models: entries } };
  }

  static command(overrides: Record<string, unknown> = {}) {
    return { name: "review", ...overrides };
  }

  static commandsResponse(
    entries: ReadonlyArray<Record<string, unknown>> = [CatalogRpcFixture.command()],
  ) {
    return { data: { commands: entries } };
  }

  static provider(overrides: Record<string, unknown> = {}) {
    return {
      id: "anthropic",
      name: "Anthropic",
      available: true,
      authenticated: false,
      ...overrides,
    };
  }

  static providersResponse(
    entries: ReadonlyArray<Record<string, unknown>> = [CatalogRpcFixture.provider()],
  ) {
    return { data: { providers: entries } };
  }
}

const expectRequestError = (error: unknown, method: string, detail: string) => {
  expect(isProviderAdapterRequestError(error)).toBe(true);
  if (!isProviderAdapterRequestError(error)) {
    return;
  }
  expect(error.provider).toBe("omp");
  expect(error.method).toBe(method);
  expect(error.detail).toBe(detail);
};

describe("OmpCatalogDecoder", () => {
  describe("decodeModels", () => {
    it.effect(
      "Given padded provider and id, When decodeModels runs, Then the slug is trimmed provider/id",
      () =>
        Effect.gen(function* () {
          const decoder = new OmpCatalogDecoder();

          const models = yield* decoder.decodeModels(
            CatalogRpcFixture.modelsResponse([
              CatalogRpcFixture.model({ provider: " anthropic ", id: " claude-sonnet-4 " }),
            ]),
          );

          expect(models).toMatchObject([
            { slug: "anthropic/claude-sonnet-4", isCustom: false, capabilities: null },
          ]);
        }),
    );

    it.effect("Given a model with no name, When decodeModels runs, Then name equals the slug", () =>
      Effect.gen(function* () {
        const decoder = new OmpCatalogDecoder();

        const models = yield* decoder.decodeModels(
          CatalogRpcFixture.modelsResponse([
            CatalogRpcFixture.model({ id: "gpt-5", name: undefined }),
          ]),
        );

        expect(models).toMatchObject([{ slug: "openai/gpt-5", name: "openai/gpt-5" }]);
      }),
    );

    it.effect(
      "Given an empty models array, When decodeModels runs, Then the catalog is empty",
      () =>
        Effect.gen(function* () {
          const decoder = new OmpCatalogDecoder();

          const models = yield* decoder.decodeModels(CatalogRpcFixture.modelsResponse([]));

          expect(models).toEqual([]);
        }),
    );

    it.effect(
      "Given a response without data.models, When decodeModels runs, Then ProviderAdapterRequestError names get_available_models",
      () =>
        Effect.gen(function* () {
          const decoder = new OmpCatalogDecoder();

          const error = yield* decoder.decodeModels({}).pipe(Effect.flip);

          expectRequestError(
            error,
            "get_available_models",
            "response data.models must be an array",
          );
        }),
    );

    it.effect(
      "Given a model missing id, When decodeModels runs, Then ProviderAdapterRequestError requires provider and id",
      () =>
        Effect.gen(function* () {
          const decoder = new OmpCatalogDecoder();

          const error = yield* decoder
            .decodeModels(CatalogRpcFixture.modelsResponse([CatalogRpcFixture.model({ id: 1 })]))
            .pipe(Effect.flip);

          expectRequestError(
            error,
            "get_available_models",
            "each model requires provider and id strings",
          );
        }),
    );
  });

  describe("decodeSlashCommands", () => {
    it.effect(
      "Given a command name with a leading slash, When decodeSlashCommands runs, Then the name is unprefixed",
      () =>
        Effect.gen(function* () {
          const decoder = new OmpCatalogDecoder();

          const commands = yield* decoder.decodeSlashCommands(
            CatalogRpcFixture.commandsResponse([CatalogRpcFixture.command({ name: "/model" })]),
          );

          expect(commands).toMatchObject([{ name: "model" }]);
        }),
    );

    it.effect(
      "Given a whitespace-only description, When decodeSlashCommands runs, Then description is omitted",
      () =>
        Effect.gen(function* () {
          const decoder = new OmpCatalogDecoder();

          const commands = yield* decoder.decodeSlashCommands(
            CatalogRpcFixture.commandsResponse([CatalogRpcFixture.command({ description: "   " })]),
          );

          expect(commands).toEqual([{ name: "review" }]);
        }),
    );

    it.effect(
      "Given an input hint, When decodeSlashCommands runs, Then the command keeps that hint",
      () =>
        Effect.gen(function* () {
          const decoder = new OmpCatalogDecoder();

          const commands = yield* decoder.decodeSlashCommands(
            CatalogRpcFixture.commandsResponse([
              CatalogRpcFixture.command({ input: { hint: "provider/model" } }),
            ]),
          );

          expect(commands).toMatchObject([{ name: "review", input: { hint: "provider/model" } }]);
        }),
    );

    it.effect(
      "Given an empty commands array, When decodeSlashCommands runs, Then the catalog is empty",
      () =>
        Effect.gen(function* () {
          const decoder = new OmpCatalogDecoder();

          const commands = yield* decoder.decodeSlashCommands(
            CatalogRpcFixture.commandsResponse([]),
          );

          expect(commands).toEqual([]);
        }),
    );

    it.effect(
      "Given a response without data.commands, When decodeSlashCommands runs, Then ProviderAdapterRequestError names get_available_commands",
      () =>
        Effect.gen(function* () {
          const decoder = new OmpCatalogDecoder();

          const error = yield* decoder.decodeSlashCommands({}).pipe(Effect.flip);

          expectRequestError(
            error,
            "get_available_commands",
            "response data.commands must be an array",
          );
        }),
    );

    it.effect(
      "Given a command with an empty name, When decodeSlashCommands runs, Then ProviderAdapterRequestError requires a non-empty name",
      () =>
        Effect.gen(function* () {
          const decoder = new OmpCatalogDecoder();

          const error = yield* decoder
            .decodeSlashCommands(
              CatalogRpcFixture.commandsResponse([CatalogRpcFixture.command({ name: "   " })]),
            )
            .pipe(Effect.flip);

          expectRequestError(
            error,
            "get_available_commands",
            "each command requires a non-empty name",
          );
        }),
    );
  });

  describe("decodeLoginProviders", () => {
    it.effect(
      "Given an unauthenticated provider, When decodeLoginProviders runs, Then authenticated stays false",
      () =>
        Effect.gen(function* () {
          const decoder = new OmpCatalogDecoder();

          const providers = yield* decoder.decodeLoginProviders(
            CatalogRpcFixture.providersResponse(),
          );

          expect(providers).toEqual([
            {
              id: "anthropic",
              name: "Anthropic",
              available: true,
              authenticated: false,
            },
          ]);
        }),
    );

    it.effect(
      "Given an empty providers array, When decodeLoginProviders runs, Then the catalog is empty",
      () =>
        Effect.gen(function* () {
          const decoder = new OmpCatalogDecoder();

          const providers = yield* decoder.decodeLoginProviders(
            CatalogRpcFixture.providersResponse([]),
          );

          expect(providers).toEqual([]);
        }),
    );

    it.effect(
      "Given a response without data.providers, When decodeLoginProviders runs, Then ProviderAdapterRequestError names get_login_providers",
      () =>
        Effect.gen(function* () {
          const decoder = new OmpCatalogDecoder();

          const error = yield* decoder.decodeLoginProviders({}).pipe(Effect.flip);

          expectRequestError(
            error,
            "get_login_providers",
            "response data.providers must be an array",
          );
        }),
    );

    it.effect(
      "Given a provider missing authenticated, When decodeLoginProviders runs, Then ProviderAdapterRequestError names the required fields",
      () =>
        Effect.gen(function* () {
          const decoder = new OmpCatalogDecoder();

          const error = yield* decoder
            .decodeLoginProviders(
              CatalogRpcFixture.providersResponse([
                CatalogRpcFixture.provider({ authenticated: undefined }),
              ]),
            )
            .pipe(Effect.flip);

          expectRequestError(
            error,
            "get_login_providers",
            "each login provider requires id, name, available, authenticated",
          );
        }),
    );
  });
});
