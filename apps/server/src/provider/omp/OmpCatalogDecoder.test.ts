import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe } from "vite-plus/test";

import { OmpCatalogDecoder } from "./OmpCatalogDecoder.ts";

class CatalogRpcFixture {
  static models(entries: ReadonlyArray<Record<string, unknown>>) {
    return { data: { models: entries } };
  }

  static commands(entries: ReadonlyArray<Record<string, unknown>>) {
    return { data: { commands: entries } };
  }

  static providers(entries: ReadonlyArray<Record<string, unknown>>) {
    return { data: { providers: entries } };
  }
}

describe("OmpCatalogDecoder", () => {
  const decoder = new OmpCatalogDecoder();

  it.effect(
    "Given models with provider and id, When decodeModels runs, Then slugs are provider/id and name falls back to slug",
    () =>
      Effect.gen(function* () {
        const models = yield* decoder.decodeModels(
          CatalogRpcFixture.models([
            { provider: "openai", id: "gpt-5", name: "GPT-5" },
            { provider: " anthropic ", id: " claude-sonnet-4 " },
          ]),
        );

        expect(models).toEqual([
          { slug: "openai/gpt-5", name: "GPT-5", isCustom: false, capabilities: null },
          {
            slug: "anthropic/claude-sonnet-4",
            name: "anthropic/claude-sonnet-4",
            isCustom: false,
            capabilities: null,
          },
        ]);
      }),
  );

  it.effect(
    "Given a response without data.models, When decodeModels runs, Then ProviderAdapterRequestError names get_available_models",
    () =>
      Effect.gen(function* () {
        const error = yield* decoder.decodeModels({}).pipe(Effect.flip);

        expect(error._tag).toBe("ProviderAdapterRequestError");
        expect(error.method).toBe("get_available_models");
        expect(error.detail).toBe("response data.models must be an array");
      }),
  );

  it.effect(
    "Given a model entry missing provider or id, When decodeModels runs, Then ProviderAdapterRequestError names the missing fields",
    () =>
      Effect.gen(function* () {
        const error = yield* decoder
          .decodeModels(CatalogRpcFixture.models([{ provider: "openai" }]))
          .pipe(Effect.flip);

        expect(error._tag).toBe("ProviderAdapterRequestError");
        expect(error.method).toBe("get_available_models");
        expect(error.detail).toBe("each model requires provider and id strings");
      }),
  );

  it.effect(
    "Given commands with a leading slash and optional hint, When decodeSlashCommands runs, Then names are unprefixed and empty description is omitted",
    () =>
      Effect.gen(function* () {
        const commands = yield* decoder.decodeSlashCommands(
          CatalogRpcFixture.commands([
            {
              name: "/model",
              description: "Switch model",
              input: { hint: "provider/model" },
            },
            { name: "  review  ", description: "   " },
          ]),
        );

        expect(commands).toEqual([
          {
            name: "model",
            description: "Switch model",
            input: { hint: "provider/model" },
          },
          { name: "review" },
        ]);
      }),
  );

  it.effect(
    "Given a response without data.commands, When decodeSlashCommands runs, Then ProviderAdapterRequestError names get_available_commands",
    () =>
      Effect.gen(function* () {
        const error = yield* decoder.decodeSlashCommands({}).pipe(Effect.flip);

        expect(error._tag).toBe("ProviderAdapterRequestError");
        expect(error.method).toBe("get_available_commands");
        expect(error.detail).toBe("response data.commands must be an array");
      }),
  );

  it.effect(
    "Given a command with an empty name, When decodeSlashCommands runs, Then ProviderAdapterRequestError requires a non-empty name",
    () =>
      Effect.gen(function* () {
        const error = yield* decoder
          .decodeSlashCommands(CatalogRpcFixture.commands([{ name: "   " }]))
          .pipe(Effect.flip);

        expect(error._tag).toBe("ProviderAdapterRequestError");
        expect(error.method).toBe("get_available_commands");
        expect(error.detail).toBe("each command requires a non-empty name");
      }),
  );

  it.effect(
    "Given login providers with id name available authenticated, When decodeLoginProviders runs, Then those fields are returned",
    () =>
      Effect.gen(function* () {
        const providers = yield* decoder.decodeLoginProviders(
          CatalogRpcFixture.providers([
            {
              id: "openai-codex",
              name: "ChatGPT Plus/Pro",
              available: true,
              authenticated: true,
            },
            {
              id: "anthropic",
              name: "Anthropic",
              available: true,
              authenticated: false,
            },
          ]),
        );

        expect(providers).toEqual([
          {
            id: "openai-codex",
            name: "ChatGPT Plus/Pro",
            available: true,
            authenticated: true,
          },
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
    "Given a response without data.providers, When decodeLoginProviders runs, Then ProviderAdapterRequestError names get_login_providers",
    () =>
      Effect.gen(function* () {
        const error = yield* decoder.decodeLoginProviders({}).pipe(Effect.flip);

        expect(error._tag).toBe("ProviderAdapterRequestError");
        expect(error.method).toBe("get_login_providers");
        expect(error.detail).toBe("response data.providers must be an array");
      }),
  );

  it.effect(
    "Given a provider missing authenticated, When decodeLoginProviders runs, Then ProviderAdapterRequestError names the required fields",
    () =>
      Effect.gen(function* () {
        const error = yield* decoder
          .decodeLoginProviders(
            CatalogRpcFixture.providers([{ id: "anthropic", name: "Anthropic", available: true }]),
          )
          .pipe(Effect.flip);

        expect(error._tag).toBe("ProviderAdapterRequestError");
        expect(error.method).toBe("get_login_providers");
        expect(error.detail).toBe(
          "each login provider requires id, name, available, authenticated",
        );
      }),
  );
});
