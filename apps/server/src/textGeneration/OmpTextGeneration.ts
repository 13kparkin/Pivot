/**
 * OmpTextGeneration — short structured JSON helpers via `omp --mode rpc-ui`.
 *
 * Spawns an ephemeral RPC session per call, prompts for JSON, collects
 * assistant text until terminal `agent_end` (or local-only prompt completion),
 * then decodes against the shared prompt schemas. Text is taken from streamed
 * `text_delta` first, then the completed assistant message, then
 * `get_last_assistant_text`, then thinking. Bare model ids (the default
 * `gpt-5.6-luna`) are resolved against `get_available_models` so the helper
 * does not silently keep omp's default model. Confirm/select UI is answered;
 * assistant `stopReason: "error"` is surfaced instead of "empty output".
 *
 * @module textGeneration/OmpTextGeneration
 */
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { type ModelSelection, type OmpSettings, TextGenerationError } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";

import { OmpRpcRuntime, OmpSpawnError } from "../provider/omp/index.ts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";

const OMP_TIMEOUT_MS = 180_000;

const isTextGenerationError = Schema.is(TextGenerationError);
const isOmpSpawnError = Schema.is(OmpSpawnError);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseOmpModelSlug(slug: string): { provider: string; modelId: string } | null {
  const slash = slug.indexOf("/");
  if (slash <= 0 || slash === slug.length - 1) {
    return null;
  }
  return { provider: slug.slice(0, slash), modelId: slug.slice(slash + 1) };
}

interface OmpCatalogModel {
  readonly provider: string;
  readonly id: string;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  let out = "";
  for (const block of content) {
    if (!isRecord(block) || typeof block.text !== "string") {
      continue;
    }
    out += block.text;
  }
  return out;
}

function thinkingFromContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  let out = "";
  for (const block of content) {
    if (!isRecord(block) || block.type !== "thinking" || typeof block.thinking !== "string") {
      continue;
    }
    out += block.thinking;
  }
  return out;
}

function assistantErrorFromMessage(message: unknown): string | undefined {
  if (!isRecord(message) || message.role !== "assistant" || message.stopReason !== "error") {
    return undefined;
  }
  if (typeof message.errorMessage === "string" && message.errorMessage.trim().length > 0) {
    return message.errorMessage.trim();
  }
  return "omp assistant turn failed.";
}

function modelsFromAvailableModelsResponse(response: unknown): ReadonlyArray<OmpCatalogModel> {
  if (!isRecord(response) || !isRecord(response.data) || !Array.isArray(response.data.models)) {
    return [];
  }
  const models: OmpCatalogModel[] = [];
  for (const entry of response.data.models) {
    if (!isRecord(entry) || typeof entry.provider !== "string" || typeof entry.id !== "string") {
      continue;
    }
    const provider = entry.provider.trim();
    const id = entry.id.trim();
    if (provider.length === 0 || id.length === 0) {
      continue;
    }
    models.push({ provider, id });
  }
  return models;
}

function resolveOmpModel(
  slug: string,
  models: ReadonlyArray<OmpCatalogModel>,
): { provider: string; modelId: string } | null {
  const parsed = parseOmpModelSlug(slug);
  if (parsed) {
    return parsed;
  }
  const matches = models.filter((model) => model.id === slug || model.id.endsWith(`/${slug}`));
  if (matches.length === 0) {
    return null;
  }
  const preferred =
    matches.find((model) => model.provider === "openai-codex") ??
    matches.find((model) => model.provider === "openai") ??
    matches[0];
  if (preferred === undefined) {
    return null;
  }
  return { provider: preferred.provider, modelId: preferred.id };
}

function textFromLastAssistantResponse(response: unknown): string {
  if (!isRecord(response) || !isRecord(response.data) || typeof response.data.text !== "string") {
    return "";
  }
  return response.data.text.trim();
}

function thinkingLevelFromOptions(options: ModelSelection["options"]): string | undefined {
  if (options === undefined) {
    return undefined;
  }
  for (const option of options) {
    if (
      (option.id === "effort" ||
        option.id === "thinking" ||
        option.id === "reasoningEffort" ||
        option.id === "thinkingLevel") &&
      typeof option.value === "string" &&
      option.value.length > 0
    ) {
      return option.value;
    }
  }
  return undefined;
}

function firstSelectOption(options: unknown): string | undefined {
  if (!Array.isArray(options)) {
    return undefined;
  }
  for (const option of options) {
    if (typeof option === "string" && option.length > 0) {
      return option;
    }
  }
  return undefined;
}

function uiResponseForRequest(frame: Record<string, unknown>): Record<string, unknown> | null {
  if (typeof frame.id !== "string" || frame.id.length === 0) {
    return null;
  }
  if (frame.method === "confirm") {
    return { type: "extension_ui_response", id: frame.id, confirmed: true };
  }
  if (frame.method === "select") {
    const value = firstSelectOption(frame.options);
    if (value !== undefined) {
      return { type: "extension_ui_response", id: frame.id, value };
    }
    return { type: "extension_ui_response", id: frame.id, cancelled: true };
  }
  if (frame.method === "input" || frame.method === "editor") {
    return { type: "extension_ui_response", id: frame.id, cancelled: true };
  }
  return null;
}

function mapOmpError(operation: string, cause: unknown, detail: string): TextGenerationError {
  if (isTextGenerationError(cause)) {
    return cause;
  }
  if (isOmpSpawnError(cause)) {
    return new TextGenerationError({
      operation,
      detail: cause.detail.length > 0 ? cause.detail : detail,
      cause,
    });
  }
  return new TextGenerationError({
    operation,
    detail,
    cause,
  });
}

/**
 * Build an omp text-generation closure bound to a specific `OmpSettings`
 * payload (binary path). Each operation spawns its own short-lived RPC child.
 */
export const makeOmpTextGeneration = Effect.fn("makeOmpTextGeneration")(function* (
  ompSettings: OmpSettings & {
    readonly resolveBinaryPath?: Effect.Effect<string>;
  },
) {
  const crypto = yield* Crypto.Crypto;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fallbackBinaryPath =
    typeof ompSettings.binaryPath === "string" && ompSettings.binaryPath.length > 0
      ? ompSettings.binaryPath
      : "omp";
  const resolveBinaryPath = ompSettings.resolveBinaryPath ?? Effect.succeed(fallbackBinaryPath);

  const runOmpJson = <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    modelSelection,
  }: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const binaryPath = yield* resolveBinaryPath;
      const runtime = new OmpRpcRuntime(commandSpawner, binaryPath);
      const sessionKey = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      yield* Effect.addFinalizer(() => runtime.dispose(sessionKey));

      yield* runtime
        .ensureSession({
          sessionKey,
          cwd,
          resumeCursor: null,
        })
        .pipe(
          Effect.mapError((cause) =>
            mapOmpError(operation, cause, "Failed to start omp RPC session for text generation."),
          ),
        );

      const textDeltaRef = yield* Ref.make("");
      const messageTextRef = yield* Ref.make("");
      const thinkingRef = yield* Ref.make("");
      const errorRef = yield* Ref.make<string | undefined>(undefined);
      const done = yield* Deferred.make<void, TextGenerationError>();

      const applyAssistantMessage = (message: unknown) => {
        if (!isRecord(message) || message.role !== "assistant") {
          return Effect.void;
        }
        const text = textFromContent(message.content);
        const thinking = thinkingFromContent(message.content);
        const error = assistantErrorFromMessage(message);
        return Effect.gen(function* () {
          if (text.length > 0) {
            yield* Ref.set(messageTextRef, text);
          }
          if (thinking.length > 0) {
            yield* Ref.set(thinkingRef, thinking);
          }
          if (error !== undefined) {
            yield* Ref.set(errorRef, error);
          }
        });
      };

      const drainFiber = yield* runtime.streamFrames(sessionKey).pipe(
        Stream.runForEach((frame) => {
          if (!isRecord(frame) || typeof frame.type !== "string") {
            return Effect.void;
          }
          if (frame.type === "extension_ui_request") {
            const response = uiResponseForRequest(frame);
            if (response === null) {
              return Effect.void;
            }
            return runtime.write(sessionKey, response).pipe(Effect.ignore);
          }
          if (frame.type === "host_uri_request" && typeof frame.id === "string") {
            return runtime
              .write(sessionKey, {
                type: "host_uri_result",
                id: frame.id,
                isError: true,
                error: "text generation does not accept host URI requests",
              })
              .pipe(Effect.ignore);
          }
          if (frame.type === "message_update") {
            const event = frame.assistantMessageEvent;
            const captureMessage = applyAssistantMessage(frame.message);
            if (
              isRecord(event) &&
              event.type === "text_delta" &&
              typeof event.delta === "string" &&
              event.delta.length > 0
            ) {
              return Ref.update(textDeltaRef, (current) => current + event.delta).pipe(
                Effect.andThen(captureMessage),
              );
            }
            if (
              isRecord(event) &&
              event.type === "thinking_delta" &&
              typeof event.delta === "string" &&
              event.delta.length > 0
            ) {
              return Ref.update(thinkingRef, (current) => current + event.delta).pipe(
                Effect.andThen(captureMessage),
              );
            }
            return captureMessage;
          }
          if (frame.type === "message_end") {
            return applyAssistantMessage(frame.message);
          }
          if (frame.type === "agent_end" && frame.isTerminal !== false) {
            const messages = Array.isArray(frame.messages) ? frame.messages : [];
            return Effect.forEach(messages, applyAssistantMessage, { discard: true }).pipe(
              Effect.andThen(Deferred.succeed(done, undefined)),
              Effect.ignore,
            );
          }
          if (frame.type === "prompt_result" && frame.agentInvoked === false) {
            return Deferred.succeed(done, undefined).pipe(Effect.ignore);
          }
          return Effect.void;
        }),
        Effect.catch((cause) =>
          Deferred.fail(
            done,
            mapOmpError(operation, cause, "omp RPC stream failed during text generation."),
          ).pipe(Effect.ignore),
        ),
        Effect.forkChild,
      );

      const catalogResponse = yield* runtime
        .send(sessionKey, { type: "get_available_models" })
        .pipe(Effect.catch(() => Effect.succeed({})));
      const parsedModel = resolveOmpModel(
        modelSelection.model,
        modelsFromAvailableModelsResponse(catalogResponse),
      );
      if (parsedModel) {
        yield* runtime
          .send(sessionKey, {
            type: "set_model",
            provider: parsedModel.provider,
            modelId: parsedModel.modelId,
          })
          .pipe(
            Effect.mapError((cause) =>
              mapOmpError(operation, cause, "Failed to set omp model for text generation."),
            ),
          );
      }

      const thinkingLevel = thinkingLevelFromOptions(modelSelection.options);
      if (thinkingLevel !== undefined) {
        yield* runtime
          .send(sessionKey, {
            type: "set_thinking_level",
            level: thinkingLevel,
          })
          .pipe(Effect.ignore);
      }

      const response = yield* runtime
        .send(sessionKey, {
          type: "prompt",
          message: prompt,
        })
        .pipe(
          Effect.mapError((cause) =>
            mapOmpError(operation, cause, "omp prompt failed during text generation."),
          ),
        );

      if (isRecord(response) && isRecord(response.data) && response.data.agentInvoked === false) {
        yield* Deferred.succeed(done, undefined).pipe(Effect.ignore);
      }

      yield* Deferred.await(done).pipe(
        Effect.timeoutOption(OMP_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({
                  operation,
                  detail: "omp text generation timed out.",
                }),
              ),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
        Effect.ensuring(Fiber.interrupt(drainFiber)),
      );

      const lastAssistantResponse = yield* runtime
        .send(sessionKey, { type: "get_last_assistant_text" })
        .pipe(Effect.catch(() => Effect.succeed({})));
      const textDelta = (yield* Ref.get(textDeltaRef)).trim();
      const messageText = (yield* Ref.get(messageTextRef)).trim();
      const lastAssistantText = textFromLastAssistantResponse(lastAssistantResponse);
      const thinking = (yield* Ref.get(thinkingRef)).trim();
      const trimmed = textDelta || messageText || lastAssistantText || thinking;
      if (!trimmed) {
        const assistantError = yield* Ref.get(errorRef);
        return yield* new TextGenerationError({
          operation,
          detail:
            assistantError !== undefined
              ? assistantError
              : "omp returned empty output for text generation.",
        });
      }

      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson));
      return yield* decodeOutput(extractJsonObject(trimmed)).pipe(
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail: "omp returned invalid structured output.",
                cause,
              }),
            ),
        }),
      );
    }).pipe(
      Effect.mapError((cause) => mapOmpError(operation, cause, "omp text generation failed.")),
      Effect.scoped,
    );

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("OmpTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });

      const generated = yield* runOmpJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("OmpTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });

      const generated = yield* runOmpJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizePrTitle(generated.title),
        body: generated.body.trim(),
      };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("OmpTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });

      const generated = yield* runOmpJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        branch: sanitizeBranchFragment(generated.branch),
      };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("OmpTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        previousTitle: input.previousTitle,
        attachments: input.attachments,
      });

      const generated = yield* runOmpJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizeThreadTitle(generated.title),
      } satisfies TextGeneration.ThreadTitleGenerationResult;
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});
