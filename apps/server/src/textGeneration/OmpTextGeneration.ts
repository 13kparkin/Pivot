/**
 * OmpTextGeneration — short structured JSON helpers via `omp --mode rpc`.
 *
 * Spawns an ephemeral RPC session per call, prompts for JSON, collects
 * `message_update` text_delta frames until terminal `agent_end` (or local-only
 * prompt completion), then decodes against the shared prompt schemas.
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

import { OmpRpcRuntime, OmpSpawnError } from "../provider/omp/OmpRpcRuntime.ts";
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

function mapOmpError(operation: string, cause: unknown, detail: string): TextGenerationError {
  if (isTextGenerationError(cause)) {
    return cause;
  }
  if (cause instanceof OmpSpawnError) {
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

      const outputRef = yield* Ref.make("");
      const done = yield* Deferred.make<void, TextGenerationError>();

      const drainFiber = yield* runtime.streamFrames(sessionKey).pipe(
        Stream.runForEach((frame) => {
          if (!isRecord(frame) || typeof frame.type !== "string") {
            return Effect.void;
          }
          if (frame.type === "extension_ui_request" && typeof frame.id === "string") {
            return runtime
              .write(sessionKey, {
                type: "extension_ui_response",
                id: frame.id,
                cancelled: true,
              })
              .pipe(Effect.ignore);
          }
          if (frame.type === "message_update") {
            const event = frame.assistantMessageEvent;
            if (
              isRecord(event) &&
              event.type === "text_delta" &&
              typeof event.delta === "string" &&
              event.delta.length > 0
            ) {
              return Ref.update(outputRef, (current) => current + event.delta);
            }
            return Effect.void;
          }
          if (frame.type === "agent_end" && frame.isTerminal !== false) {
            return Deferred.succeed(done, undefined).pipe(Effect.ignore);
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

      const parsedModel = parseOmpModelSlug(modelSelection.model);
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

      const trimmed = (yield* Ref.get(outputRef)).trim();
      if (!trimmed) {
        return yield* new TextGenerationError({
          operation,
          detail: "omp returned empty output for text generation.",
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
