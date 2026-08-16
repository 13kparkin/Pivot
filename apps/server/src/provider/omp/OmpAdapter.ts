/**
 * OmpAdapter — maps omp RPC session frames onto ProviderRuntimeEvent.
 *
 * Turn completion (AC11): terminal `agent_end` (`isTerminal !== false`),
 * prompt `data.agentInvoked === false`, and `prompt_result` with
 * `agentInvoked: false`. Local slash results arrive as `command_output`
 * frames and become `status_text` deltas. Interim assistant runs are
 * classified as `status_text`; the held-back run is flushed as
 * `assistant_text` at terminal completion. Empty assistant deltas are
 * not emitted (AC2).
 * Tools: `toolcall_end` / `tool_execution_*` → `item.*` (+ output deltas).
 * Thinking: `thinking_delta` → `content.delta` (`reasoning_text`).
 * Usage: `get_state.contextUsage` → `thread.token-usage.updated` on turn end.
 * Subagents (AC7): `set_subagent_subscription` + `subagent_*` → `task.*`.
 * Host UI: `extension_ui_request` confirm/select/input/editor → approval /
 * user-input events; replies via `extension_ui_response`.
 * Plan mode: on `interactionMode: "plan"` remember the current model via
 * `get_state`, `set_model` to the resolved plan role, and restore on exit.
 * While plan is active, turn `modelSelection` is ignored.
 *
 * @module provider/omp/OmpAdapter
 */
import {
  type ApprovalRequestId,
  type CanonicalItemType,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderSendTurnInput,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  type RuntimeTaskStatus,
  type RuntimeSubagentActivityStatus,
  type RuntimeSubagentAssignmentStatus,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
  ProviderDriverKind,
  RuntimeTaskId,
  type RuntimeMode,
  type ProviderInteractionMode,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import type { ServerOmpAgentCapabilities, ServerOmpAgentChatEntry } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type {
  OmpDeleteResourceInput,
  OmpMoveItemInput,
  OmpReadResourceInput,
  OmpResetSettingInput,
  OmpWriteResourceInput,
  OmpWriteSettingInput,
  ProjectId,
} from "@t3tools/contracts";
import type { OmpCapabilitiesService } from "./OmpCapabilitiesService.ts";
import { OmpSpawnError, type OmpRpcRuntime } from "./OmpRpcRuntime.ts";

const PROVIDER = ProviderDriverKind.make("omp");
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const isProviderAdapterProcessError = Schema.is(ProviderAdapterProcessError);
const isOmpSpawnError = Schema.is(OmpSpawnError);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const OMP_AGENT_RPC_READ_ONLY_REASON =
  "This OMP version does not expose agent-targeted messaging over RPC.";

const OMP_AGENT_READ_ONLY_CAPABILITIES: ServerOmpAgentCapabilities = {
  message: false,
  revive: false,
  cancel: false,
  kill: false,
  readOnlyReason: OMP_AGENT_RPC_READ_ONLY_REASON,
};

function transcriptText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(transcriptText).filter(Boolean).join("");
  }
  if (!isRecord(value)) {
    return value === null || value === undefined ? "" : String(value);
  }
  if (typeof value.text === "string") {
    return value.text;
  }
  if (typeof value.content === "string" || Array.isArray(value.content)) {
    return transcriptText(value.content);
  }
  return "";
}

function transcriptRole(value: unknown): ServerOmpAgentChatEntry["role"] {
  switch (value) {
    case "user":
    case "assistant":
    case "system":
    case "tool":
    case "custom":
      return value;
    default:
      return "unknown";
  }
}

function transcriptTimestamp(message: Record<string, unknown>): string | undefined {
  const candidate =
    typeof message.createdAt === "string"
      ? message.createdAt
      : typeof message.timestamp === "string"
        ? message.timestamp
        : undefined;
  return candidate !== undefined && !Number.isNaN(Date.parse(candidate)) ? candidate : undefined;
}

function normalizeTranscriptMessages(
  messages: ReadonlyArray<unknown>,
  fromByte: number,
): ReadonlyArray<ServerOmpAgentChatEntry> {
  const entries: ServerOmpAgentChatEntry[] = [];
  messages.forEach((message, messageIndex) => {
    const baseId = `${fromByte}:${messageIndex}`;
    if (!isRecord(message)) {
      entries.push({
        id: baseId,
        kind: "message",
        role: "unknown",
        text: transcriptText(message),
      });
      return;
    }

    const role = transcriptRole(message.role);
    const createdAt = transcriptTimestamp(message);
    const content = Array.isArray(message.content) ? message.content : null;
    const toolParts =
      content?.filter(
        (part) =>
          isRecord(part) &&
          (part.type === "toolCall" ||
            part.type === "tool_use" ||
            part.type === "toolResult" ||
            part.type === "tool_result"),
      ) ?? [];

    if (toolParts.length > 0) {
      const prose = content
        ?.filter((part) => !toolParts.includes(part))
        .map(transcriptText)
        .filter(Boolean)
        .join("");
      if (prose) {
        entries.push({
          id: `${baseId}:text`,
          kind: "message",
          role,
          text: prose,
          ...(createdAt === undefined ? {} : { createdAt }),
        });
      }
      toolParts.forEach((part, partIndex) => {
        const record = part as Record<string, unknown>;
        const toolName =
          typeof record.name === "string"
            ? record.name
            : typeof message.toolName === "string"
              ? message.toolName
              : undefined;
        const toolCallId =
          typeof record.id === "string"
            ? record.id
            : typeof record.toolCallId === "string"
              ? record.toolCallId
              : undefined;
        const toolInput = record.input ?? record.arguments;
        const toolOutput = record.output ?? record.result ?? record.content;
        entries.push({
          id: `${baseId}:tool:${partIndex}`,
          kind: "tool",
          role: "tool",
          text: transcriptText(toolOutput) || transcriptText(record),
          ...(toolName === undefined ? {} : { toolName }),
          ...(toolCallId === undefined ? {} : { toolCallId }),
          ...(toolInput === undefined ? {} : { toolInput }),
          ...(toolOutput === undefined ? {} : { toolOutput }),
          ...(record.isError === true ? { isError: true } : {}),
          ...(createdAt === undefined ? {} : { createdAt }),
        });
      });
      return;
    }

    const toolName =
      typeof message.toolName === "string"
        ? message.toolName
        : typeof message.name === "string" && role === "tool"
          ? message.name
          : undefined;
    const toolCallId =
      typeof message.toolCallId === "string"
        ? message.toolCallId
        : typeof message.tool_call_id === "string"
          ? message.tool_call_id
          : undefined;
    const kind =
      role === "tool" || toolName !== undefined ? ("tool" as const) : ("message" as const);
    const text =
      transcriptText(message.content) ||
      transcriptText(message.text) ||
      (kind === "tool" ? transcriptText(message.output ?? message.result) : "");
    entries.push({
      id: baseId,
      kind,
      role,
      text,
      ...(toolName === undefined ? {} : { toolName }),
      ...(toolCallId === undefined ? {} : { toolCallId }),
      ...(message.input === undefined ? {} : { toolInput: message.input }),
      ...(message.output === undefined && message.result === undefined
        ? {}
        : { toolOutput: message.output ?? message.result }),
      ...(message.isError === true ? { isError: true } : {}),
      ...(createdAt === undefined ? {} : { createdAt }),
    });
  });
  return entries;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function ompProgressUsage(progress: Record<string, unknown>): Record<string, number> | undefined {
  const usage = isRecord(progress.usage) ? progress.usage : progress;
  const inputTokens =
    nonNegativeNumber(usage.inputTokens) ??
    nonNegativeNumber(usage.input) ??
    nonNegativeNumber(usage.promptTokens);
  const cachedInputTokens =
    nonNegativeNumber(usage.cachedInputTokens) ??
    nonNegativeNumber(usage.cacheReadTokens) ??
    nonNegativeNumber(usage.cacheRead);
  const outputTokens =
    nonNegativeNumber(usage.outputTokens) ??
    nonNegativeNumber(usage.output) ??
    nonNegativeNumber(usage.completionTokens);
  const reasoningOutputTokens =
    nonNegativeNumber(usage.reasoningOutputTokens) ?? nonNegativeNumber(usage.reasoningTokens);
  const explicitTotal = nonNegativeNumber(usage.totalTokens) ?? nonNegativeNumber(usage.tokens);
  const totalTokens =
    explicitTotal ??
    (inputTokens !== undefined || outputTokens !== undefined
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : undefined);
  if (totalTokens === undefined) {
    return undefined;
  }
  const toolUses =
    nonNegativeNumber(progress.toolUses) ??
    nonNegativeNumber(progress.toolCount) ??
    (Array.isArray(progress.recentTools) ? progress.recentTools.length : undefined);
  const durationMs =
    nonNegativeNumber(progress.durationMs) ?? nonNegativeNumber(progress.elapsedMs);
  return {
    totalTokens,
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(reasoningOutputTokens === undefined ? {} : { reasoningOutputTokens }),
    ...(toolUses === undefined ? {} : { toolUses }),
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}

function ompAssignmentStatus(status: unknown): RuntimeSubagentAssignmentStatus | undefined {
  switch (status) {
    case "pending":
      return "queued";
    case "running":
    case "completed":
    case "failed":
    case "cancelled":
      return status;
    case "waiting":
      return "running";
    case "idle":
      return "completed";
    case "aborted":
    case "interrupted":
      return "cancelled";
    default:
      return undefined;
  }
}

function ompActivityStatus(progress: Record<string, unknown>): RuntimeSubagentActivityStatus {
  if (progress.rateLimited === true || progress.status === "rate_limited") {
    return "rate_limited";
  }
  const retryCount = nonNegativeNumber(progress.retryCount);
  if (retryCount !== undefined && retryCount > 0) {
    return "retrying";
  }
  if (progress.status === "waiting" || progress.waiting === true) {
    return "waiting";
  }
  if (progress.status === "budget_stopped" || progress.budgetStopped === true) {
    return "budget_stopped";
  }
  return "working";
}

/** Normalize omp Rule condition/scope fields (string or string[]) to string[]. */
function toRuleStringArray(value: unknown): string[] | undefined {
  if (typeof value === "string") {
    return value.length > 0 ? [value] : undefined;
  }
  if (Array.isArray(value)) {
    const entries = value.filter(
      (entry): entry is string => typeof entry === "string" && entry.length > 0,
    );
    return entries.length > 0 ? entries : undefined;
  }
  return undefined;
}

function mapOmpSpawnError(threadId: ThreadId, cause: OmpSpawnError): ProviderAdapterProcessError {
  return new ProviderAdapterProcessError({
    provider: PROVIDER,
    threadId,
    detail: cause.message,
    cause,
  });
}

export interface OmpLoginProvider {
  readonly id: string;
  readonly name: string;
  readonly available: boolean;
  readonly authenticated: boolean;
}

export interface OmpOpenUrlRequest {
  readonly url: string;
  readonly launchUrl?: string;
  readonly instructions?: string;
}

interface TrackedOmpToolCall {
  readonly toolName: string;
  readonly args: unknown;
  readonly intent: string | undefined;
}

type PendingExtensionUiKind = "confirm" | "select" | "input" | "editor" | "host_uri";

interface PendingExtensionUiRequest {
  readonly kind: PendingExtensionUiKind;
  readonly ompId: string;
}

interface LiveAdapterSession {
  readonly threadId: ThreadId;
  readonly sessionFile: string;
  readonly runtimeMode: RuntimeMode;
  readonly cwd: string;
  readonly snapshot: ProviderSession;
  readonly scope: Scope.Scope;
  readonly toolCalls: Map<string, TrackedOmpToolCall>;
  readonly pendingUiRequests: Map<string, PendingExtensionUiRequest>;
  /** Subagent ids seen via `subagent_lifecycle started` and not yet terminal. */
  readonly liveSubagents: Set<string>;
  turnId: TurnId | undefined;
  /** Set by interruptTurn; cleared when the terminal agent_end confirms stop. */
  stopRequested: boolean;
  /** Wall-clock ms of the last mid-turn token-usage emit (throttle). */
  lastTokenUsageEmitAtMs: number;
  /** Text deltas of the currently-open assistant run (null = no open run). */
  openRunText: string | null;
  /** Text of the most recently closed run, parked as candidate-final. */
  heldBackRunText: string | null;
  interactionMode: ProviderInteractionMode;
  prePlanModelSlug: string | undefined;
  onOpenUrl: ((request: OmpOpenUrlRequest) => Effect.Effect<void>) | undefined;
}

const TOKEN_USAGE_EMIT_MIN_INTERVAL_MS = 1_000;
/** How long interruptTurn waits for omp to acknowledge `abort` before force-stopping. */
const OMP_ABORT_ACK_TIMEOUT = "10 seconds";

export type OmpResolveRoleModel = (role: string) => Effect.Effect<string | undefined>;

export interface OmpAdapterOptions {
  readonly resolveRoleModel?: OmpResolveRoleModel;
  readonly capabilitiesService?: Pick<
    OmpCapabilitiesService,
    | "getSnapshot"
    | "writeSetting"
    | "resetSetting"
    | "readResource"
    | "writeResource"
    | "deleteResource"
    | "moveItemToOmp"
  >;
}

export type OmpSubagentSubscriptionLevel = "off" | "progress" | "events";

export interface OmpSubagentTranscriptPage {
  readonly sessionFile: string;
  readonly fromByte: number;
  readonly nextByte: number;
  readonly reset: boolean;
  readonly entries: ReadonlyArray<ServerOmpAgentChatEntry>;
  readonly capabilities: ServerOmpAgentCapabilities;
}

/**
 * Structural RPC client used by the adapter. Tests pass a fake; production
 * passes `OmpRpcRuntime`.
 */
export type OmpRpcClient = Pick<
  OmpRpcRuntime,
  "ensureSession" | "send" | "write" | "streamFrames" | "dispose"
>;

export class OmpAdapter {
  readonly provider = PROVIDER;
  readonly capabilities = { sessionModelSwitch: "in-session" as const };
  readonly #events = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
  readonly #sessions = new Map<ThreadId, LiveAdapterSession>();
  readonly #runtime: OmpRpcClient;
  readonly #randomUUID: Effect.Effect<string>;
  readonly #resolveRoleModel: OmpResolveRoleModel;
  readonly #capabilitiesService: OmpAdapterOptions["capabilitiesService"];
  readonly #subagentRevision = { current: 0 };

  public constructor(
    runtime: OmpRpcClient,
    randomUUID: Effect.Effect<string>,
    options: OmpAdapterOptions = {},
  ) {
    this.#runtime = runtime;
    this.#randomUUID = randomUUID;
    this.#resolveRoleModel = options.resolveRoleModel ?? (() => Effect.succeed(undefined));
    this.#capabilitiesService = options.capabilitiesService;
  }

  private requireCapabilitiesService(): Effect.Effect<
    NonNullable<OmpAdapterOptions["capabilitiesService"]>,
    ProviderAdapterRequestError
  > {
    if (this.#capabilitiesService === undefined) {
      return Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "capabilities",
          detail: "omp capabilities service is not configured",
        }),
      );
    }
    return Effect.succeed(this.#capabilitiesService);
  }

  /** omp Capabilities: snapshot of the discovered OMP config surface (non-thread op). */
  public capabilitiesSnapshot(
    projectId?: ProjectId,
    options?: { readonly includeAllProjects?: boolean },
  ) {
    return this.requireCapabilitiesService().pipe(
      Effect.flatMap((service) => service.getSnapshot(projectId, options)),
    );
  }

  /** omp Capabilities: scoped setting write (non-thread op). */
  public capabilitiesWriteSetting(input: OmpWriteSettingInput) {
    return this.requireCapabilitiesService().pipe(
      Effect.flatMap((service) => service.writeSetting(input)),
    );
  }

  /** omp Capabilities: destructive setting reset, confirm-gated (non-thread op). */
  public capabilitiesResetSetting(input: OmpResetSettingInput) {
    return this.requireCapabilitiesService().pipe(
      Effect.flatMap((service) => service.resetSetting(input)),
    );
  }

  /** omp Capabilities: read one rule/skill item (non-thread op). */
  public capabilitiesReadResource(input: OmpReadResourceInput) {
    return this.requireCapabilitiesService().pipe(
      Effect.flatMap((service) => service.readResource(input)),
    );
  }

  /** omp Capabilities: create/replace a rule/skill item (non-thread op). */
  public capabilitiesWriteResource(input: OmpWriteResourceInput) {
    return this.requireCapabilitiesService().pipe(
      Effect.flatMap((service) => service.writeResource(input)),
    );
  }

  /** omp Capabilities: destructive rule/skill delete, confirm-gated (non-thread op). */
  public capabilitiesDeleteResource(input: OmpDeleteResourceInput) {
    return this.requireCapabilitiesService().pipe(
      Effect.flatMap((service) => service.deleteResource(input)),
    );
  }

  /** omp Capabilities: move a foreign-root global skill into the omp agent directory. */
  public capabilitiesMoveItem(input: OmpMoveItemInput) {
    return this.requireCapabilitiesService().pipe(
      Effect.flatMap((service) => service.moveItemToOmp(input)),
    );
  }

  public get streamEvents(): Stream.Stream<ProviderRuntimeEvent> {
    return Stream.fromQueue(this.#events);
  }

  public startSession(input: ProviderSessionStartInput) {
    return Effect.gen({ self: this }, function* () {
      const cwd = input.cwd;
      if (cwd === undefined) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: "cwd is required",
        });
      }
      const resumeCursor = typeof input.resumeCursor === "string" ? input.resumeCursor : null;
      const handle = yield* this.#runtime
        .ensureSession({
          sessionKey: input.threadId,
          cwd,
          resumeCursor,
        })
        .pipe(Effect.mapError((cause) => mapOmpSpawnError(input.threadId, cause)));
      const createdAt = yield* nowIso;
      const scope = yield* Scope.make("sequential");
      const snapshot: ProviderSession = {
        provider: PROVIDER,
        status: "ready",
        runtimeMode: input.runtimeMode,
        cwd,
        threadId: input.threadId,
        resumeCursor: handle.sessionFile,
        createdAt,
        updatedAt: createdAt,
      };
      const session: LiveAdapterSession = {
        threadId: input.threadId,
        sessionFile: handle.sessionFile,
        runtimeMode: input.runtimeMode,
        cwd,
        snapshot,
        scope,
        toolCalls: new Map(),
        pendingUiRequests: new Map(),
        liveSubagents: new Set<string>(),
        turnId: undefined,
        stopRequested: false,
        // Negative so the first mid-turn emit is not throttled when Clock is 0 (TestClock).
        lastTokenUsageEmitAtMs: -TOKEN_USAGE_EMIT_MIN_INTERVAL_MS,
        openRunText: null,
        heldBackRunText: null,
        interactionMode: "default",
        prePlanModelSlug: undefined,
        onOpenUrl: undefined,
      };
      this.#sessions.set(input.threadId, session);
      // Frame transport runs in the session scope. When it ends (child exit,
      // stream failure) or when deliberate teardown closes the scope, the fiber
      // completes; if the child died while the session is still registered,
      // settle the in-flight turn and the session instead of leaving the thread
      // permanently "running".
      yield* Effect.gen({ self: this }, function* () {
        yield* this.#runtime.streamFrames(input.threadId).pipe(
          Stream.mapError((cause) => mapOmpSpawnError(input.threadId, cause)),
          Stream.runForEach((frame) => this.#onFrame(session, frame)),
          Effect.exit,
        );
        yield* this.#onSessionTransportEnded(session);
      }).pipe(Effect.forkIn(scope));
      yield* this.#runtime
        .send(input.threadId, {
          type: "set_subagent_subscription",
          level: "progress",
        })
        .pipe(Effect.mapError((cause) => mapOmpSpawnError(input.threadId, cause)));
      yield* this.#hydrateSubagents(session);
      yield* this.#applyModelSelection(input.threadId, input.modelSelection?.model);
      return snapshot;
    });
  }

  public sendTurn(input: ProviderSendTurnInput) {
    return Effect.gen({ self: this }, function* () {
      const session = this.#sessions.get(input.threadId);
      if (!session) {
        return yield* new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId: input.threadId,
        });
      }
      const turnId = yield* this.#randomUUID.pipe(Effect.map(TurnId.make));
      session.turnId = turnId;
      session.stopRequested = false;
      session.openRunText = null;
      session.heldBackRunText = null;
      yield* this.#applyInteractionMode(session, input.interactionMode);
      if (session.interactionMode !== "plan") {
        yield* this.#applyModelSelection(input.threadId, input.modelSelection?.model);
      }
      yield* this.#applyTurnOptions(input.threadId, input.modelSelection?.options);
      yield* this.#emit({
        type: "turn.started",
        threadId: input.threadId,
        turnId,
        payload: input.modelSelection?.model ? { model: input.modelSelection.model } : {},
      });
      const response = yield* this.#send(input.threadId, {
        type: "prompt",
        ...(input.input === undefined ? {} : { message: input.input }),
      });
      if (isLocalOnlyPromptResponse(response)) {
        yield* this.#emitTurnCompleted(session);
      }
      return {
        threadId: input.threadId,
        turnId,
        resumeCursor: session.sessionFile,
      };
    });
  }

  public hasSession(threadId: ThreadId) {
    return Effect.succeed(this.#sessions.has(threadId));
  }

  public listSessions() {
    return Effect.succeed(Array.from(this.#sessions.values(), (session) => session.snapshot));
  }

  public stopSession(threadId: ThreadId) {
    return this.#clearLiveSession(threadId);
  }

  public stopAll() {
    return Effect.gen({ self: this }, function* () {
      const threadIds = Array.from(this.#sessions.keys());
      yield* Effect.forEach(threadIds, (threadId) => this.#clearLiveSession(threadId), {
        discard: true,
      });
    });
  }

  public interruptTurn(threadId: ThreadId, _turnId?: TurnId) {
    return Effect.gen({ self: this }, function* () {
      const session = this.#sessions.get(threadId);
      if (!session) {
        return yield* new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      session.stopRequested = true;
      const abortOutcome = yield* Effect.exit(
        this.#send(threadId, { type: "abort" }).pipe(Effect.timeout(OMP_ABORT_ACK_TIMEOUT)),
      );
      if (Exit.isFailure(abortOutcome)) {
        // omp did not acknowledge the abort within the timeout (child dead or
        // wedged, e.g. host restart). No terminal agent_end will arrive, so
        // settle the turn and session here instead of leaving the thread
        // permanently "running".
        yield* this.#onSessionTransportEnded(session);
      }
    });
  }

  public fetchSubagentTranscript(threadId: ThreadId, subagentId: string, fromByte?: number) {
    return Effect.gen({ self: this }, function* () {
      if (!this.#sessions.has(threadId)) {
        return yield* new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      const response = yield* this.#send(threadId, {
        type: "get_subagent_messages",
        subagentId,
        ...(fromByte === undefined ? {} : { fromByte }),
      });
      if (!isRecord(response) || !isRecord(response.data)) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "get_subagent_messages",
          detail: "response data missing",
        });
      }
      const data = response.data;
      const messages = Array.isArray(data.messages) ? data.messages : [];
      const responseFromByte = typeof data.fromByte === "number" ? data.fromByte : 0;
      return {
        sessionFile: typeof data.sessionFile === "string" ? data.sessionFile : "",
        fromByte: responseFromByte,
        nextByte: typeof data.nextByte === "number" ? data.nextByte : 0,
        reset: data.reset === true,
        entries: normalizeTranscriptMessages(messages, responseFromByte),
        capabilities: OMP_AGENT_READ_ONLY_CAPABILITIES,
      } satisfies OmpSubagentTranscriptPage;
    });
  }

  public steerSession(threadId: ThreadId, message: string) {
    return Effect.gen({ self: this }, function* () {
      if (!this.#sessions.has(threadId)) {
        return yield* new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      yield* this.#send(threadId, { type: "steer", message });
    });
  }

  public setSubagentSubscription(threadId: ThreadId, level: OmpSubagentSubscriptionLevel) {
    return Effect.gen({ self: this }, function* () {
      if (!this.#sessions.has(threadId)) {
        return yield* new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      yield* this.#send(threadId, { type: "set_subagent_subscription", level });
    });
  }

  public getSubagentCapabilities(_threadId: ThreadId, _subagentId: string) {
    return Effect.succeed(OMP_AGENT_READ_ONLY_CAPABILITIES);
  }

  public readThread(threadId: ThreadId) {
    return Effect.gen({ self: this }, function* () {
      if (!this.#sessions.has(threadId)) {
        return yield* new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      return { threadId, turns: [] as const };
    });
  }

  public setThinkingLevel(threadId: ThreadId, level: string) {
    return Effect.gen({ self: this }, function* () {
      if (!this.#sessions.has(threadId)) {
        return yield* new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      yield* this.#send(threadId, { type: "set_thinking_level", level });
    });
  }

  public setFastMode(threadId: ThreadId, enabled: boolean) {
    return Effect.gen({ self: this }, function* () {
      if (!this.#sessions.has(threadId)) {
        return yield* new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      yield* this.#send(threadId, { type: "set_fast_mode", enabled });
    });
  }

  public setAutoCompaction(threadId: ThreadId, enabled: boolean) {
    return Effect.gen({ self: this }, function* () {
      if (!this.#sessions.has(threadId)) {
        return yield* new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      yield* this.#send(threadId, { type: "set_auto_compaction", enabled });
    });
  }

  public setAutoRetry(threadId: ThreadId, enabled: boolean) {
    return Effect.gen({ self: this }, function* () {
      if (!this.#sessions.has(threadId)) {
        return yield* new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      yield* this.#send(threadId, { type: "set_auto_retry", enabled });
    });
  }

  public compact(threadId: ThreadId, customInstructions?: string) {
    return Effect.gen({ self: this }, function* () {
      if (!this.#sessions.has(threadId)) {
        return yield* new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      yield* this.#send(threadId, {
        type: "compact",
        ...(customInstructions === undefined ? {} : { customInstructions }),
      });
    });
  }

  public rollbackThread(threadId: ThreadId, numTurns: number) {
    return Effect.gen({ self: this }, function* () {
      if (!this.#sessions.has(threadId)) {
        return yield* new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      if (numTurns <= 0) {
        return { threadId, turns: [] as const };
      }
      const response = yield* this.#send(threadId, { type: "get_branch_messages" });
      if (
        !isRecord(response) ||
        !isRecord(response.data) ||
        !Array.isArray(response.data.messages)
      ) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "rollbackThread",
          detail: "get_branch_messages returned no messages",
        });
      }
      const messages = response.data.messages;
      if (messages.length < numTurns) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "rollbackThread",
          detail: `cannot rollback ${numTurns} turns; only ${messages.length} branch messages available`,
        });
      }
      const target = messages[messages.length - numTurns];
      if (!isRecord(target) || typeof target.entryId !== "string" || target.entryId.length === 0) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "rollbackThread",
          detail: "branch message missing entryId",
        });
      }
      yield* this.#send(threadId, { type: "branch", entryId: target.entryId });
      return { threadId, turns: [] as const };
    });
  }

  public respondToRequest(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) {
    return Effect.gen({ self: this }, function* () {
      const session = this.#sessions.get(threadId);
      if (!session) {
        return yield* new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      const pending = session.pendingUiRequests.get(requestId);
      if (!pending || (pending.kind !== "confirm" && pending.kind !== "host_uri")) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "respondToRequest",
          detail: `no pending extension_ui confirm for ${requestId}`,
        });
      }
      const accepted = decision === "accept" || decision === "acceptForSession";
      const response =
        pending.kind === "host_uri"
          ? decision === "cancel" || !accepted
            ? {
                type: "host_uri_result" as const,
                id: pending.ompId,
                isError: true as const,
                error: "rejected by user",
              }
            : { type: "host_uri_result" as const, id: pending.ompId }
          : decision === "cancel"
            ? {
                type: "extension_ui_response" as const,
                id: pending.ompId,
                cancelled: true as const,
              }
            : {
                type: "extension_ui_response" as const,
                id: pending.ompId,
                confirmed: accepted,
              };
      yield* this.#runtime.write(threadId, response).pipe(
        Effect.mapError((cause) =>
          isOmpSpawnError(cause)
            ? mapOmpSpawnError(threadId, cause)
            : new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "respondToRequest",
                detail: String(cause),
                cause,
              }),
        ),
      );
      session.pendingUiRequests.delete(requestId);
      yield* this.#emit({
        type: "request.resolved",
        threadId,
        turnId: session.turnId,
        requestId: RuntimeRequestId.make(pending.ompId),
        payload: {
          requestType: "command_execution_approval",
          decision,
        },
      });
    });
  }

  public respondToUserInput(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ) {
    return Effect.gen({ self: this }, function* () {
      const session = this.#sessions.get(threadId);
      if (!session) {
        return yield* new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      const pending = session.pendingUiRequests.get(requestId);
      if (
        !pending ||
        (pending.kind !== "select" && pending.kind !== "input" && pending.kind !== "editor")
      ) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "respondToUserInput",
          detail: `no pending extension_ui user-input for ${requestId}`,
        });
      }
      const value = firstUserInputAnswer(answers);
      if (value === undefined) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "respondToUserInput",
          detail: "user-input answers did not include a string value",
        });
      }
      yield* this.#runtime
        .write(threadId, {
          type: "extension_ui_response",
          id: pending.ompId,
          value,
        })
        .pipe(
          Effect.mapError((cause) =>
            isOmpSpawnError(cause)
              ? mapOmpSpawnError(threadId, cause)
              : new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "respondToUserInput",
                  detail: String(cause),
                  cause,
                }),
          ),
        );
      session.pendingUiRequests.delete(requestId);
      yield* this.#emit({
        type: "user-input.resolved",
        threadId,
        turnId: session.turnId,
        requestId: RuntimeRequestId.make(pending.ompId),
        payload: { answers },
      });
    });
  }

  public discoverModels(threadId: ThreadId) {
    return Effect.gen({ self: this }, function* () {
      if (!this.#sessions.has(threadId)) {
        return yield* new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      const response = yield* this.#send(threadId, { type: "get_available_models" });
      return yield* modelsFromAvailableModelsResponse(response);
    });
  }

  public discoverSlashCommands(threadId: ThreadId) {
    return Effect.gen({ self: this }, function* () {
      if (!this.#sessions.has(threadId)) {
        return yield* new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      const response = yield* this.#send(threadId, { type: "get_available_commands" });
      return yield* slashCommandsFromAvailableCommandsResponse(response);
    });
  }

  public listLoginProviders(threadId: ThreadId) {
    return Effect.gen({ self: this }, function* () {
      if (!this.#sessions.has(threadId)) {
        return yield* new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      const response = yield* this.#send(threadId, { type: "get_login_providers" });
      return yield* loginProvidersFromResponse(response);
    });
  }

  public login(
    threadId: ThreadId,
    providerId: string,
    onOpenUrl: (request: OmpOpenUrlRequest) => Effect.Effect<void>,
  ) {
    return Effect.gen({ self: this }, function* () {
      const session = this.#sessions.get(threadId);
      if (!session) {
        return yield* new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      session.onOpenUrl = onOpenUrl;
      return yield* this.#send(threadId, { type: "login", providerId }).pipe(
        Effect.timeout("10 minutes"),
        Effect.mapError((cause) =>
          isProviderAdapterProcessError(cause)
            ? cause
            : new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "login",
                detail: cause instanceof Error ? cause.message : String(cause),
                cause,
              }),
        ),
        Effect.map(() => ({ providerId })),
        Effect.ensuring(
          Effect.sync(() => {
            session.onOpenUrl = undefined;
          }),
        ),
      );
    });
  }

  #onFrame(session: LiveAdapterSession, frame: object): Effect.Effect<void> {
    if (!isRecord(frame) || typeof frame.type !== "string") {
      return Effect.void;
    }
    if (frame.type === "extension_ui_request") {
      return this.#onExtensionUiRequest(session, frame);
    }
    if (frame.type === "host_uri_request") {
      return this.#onHostUriRequest(session, frame);
    }
    if (frame.type === "host_uri_cancel") {
      return this.#onHostUriCancel(session, frame);
    }
    if (frame.type === "agent_end" && frame.isTerminal !== false) {
      return this.#emitTurnCompleted(session);
    }
    if (frame.type === "prompt_result" && frame.agentInvoked === false) {
      return this.#emitTurnCompleted(session);
    }
    if (frame.type === "command_output") {
      return this.#onCommandOutput(session, frame);
    }
    if (frame.type === "ttsr_triggered") {
      return this.#onTtsrTriggered(session, frame);
    }
    if (frame.type === "message_start") {
      return this.#onMessageStart(session, frame);
    }
    if (frame.type === "message_end") {
      return this.#onMessageEnd(session, frame);
    }
    if (frame.type === "message_update") {
      return this.#onMessageUpdate(session, frame).pipe(
        Effect.tap(() =>
          this.#maybeEmitLiveTokenUsage(session).pipe(Effect.forkDetach, Effect.asVoid),
        ),
      );
    }
    if (frame.type === "tool_execution_start") {
      return this.#onToolExecutionStart(session, frame);
    }
    if (frame.type === "tool_execution_update") {
      return this.#onToolExecutionUpdate(session, frame);
    }
    if (frame.type === "tool_execution_end") {
      return this.#onToolExecutionEnd(session, frame);
    }
    if (frame.type === "subagent_lifecycle") {
      return this.#onSubagentLifecycle(session, frame);
    }
    if (frame.type === "subagent_progress") {
      return this.#onSubagentProgress(session, frame);
    }
    if (frame.type === "subagent_event") {
      return this.#onSubagentEvent(session, frame);
    }
    return Effect.void;
  }

  #hydrateSubagents(session: LiveAdapterSession): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const response = yield* this.#send(session.threadId, { type: "get_subagents" });
      if (!isRecord(response) || !isRecord(response.data)) {
        return;
      }
      const snapshots = Array.isArray(response.data.subagents)
        ? response.data.subagents
        : Array.isArray(response.data.agents)
          ? response.data.agents
          : [];
      yield* Effect.forEach(
        snapshots,
        (snapshot) => {
          if (!isRecord(snapshot) || typeof snapshot.id !== "string") {
            return Effect.void;
          }
          const description =
            typeof snapshot.description === "string"
              ? snapshot.description
              : typeof snapshot.assignment === "string"
                ? snapshot.assignment
                : typeof snapshot.task === "string"
                  ? snapshot.task
                  : snapshot.id;
          return Effect.all(
            [
              this.#onSubagentLifecycle(session, {
                payload: {
                  ...snapshot,
                  description,
                  status: "started",
                },
              }),
              this.#onSubagentProgress(session, {
                payload: {
                  ...snapshot,
                  task: description,
                  progress: {
                    ...(isRecord(snapshot.progress) ? snapshot.progress : {}),
                    id: snapshot.id,
                    task: description,
                    agent: snapshot.agent,
                    index: snapshot.index,
                    status: snapshot.status === "active" ? "running" : snapshot.status,
                  },
                },
              }),
            ],
            { discard: true },
          );
        },
        { discard: true },
      );
    }).pipe(Effect.catch(() => Effect.void));
  }

  #onSubagentLifecycle(
    session: LiveAdapterSession,
    frame: Record<string, unknown>,
  ): Effect.Effect<void> {
    const payload = frame.payload;
    if (!isRecord(payload) || typeof payload.id !== "string") {
      return Effect.void;
    }
    const taskId = RuntimeTaskId.make(payload.id);
    const role = typeof payload.agent === "string" ? payload.agent : undefined;
    const description =
      typeof payload.description === "string" && payload.description.length > 0
        ? payload.description
        : undefined;
    const toolUseId =
      typeof payload.parentToolCallId === "string" ? payload.parentToolCallId : undefined;
    const parentAgentId =
      typeof payload.parentAgentId === "string" ? payload.parentAgentId : undefined;
    const sessionFile = typeof payload.sessionFile === "string" ? payload.sessionFile : undefined;
    const agentIndex = typeof payload.index === "number" ? payload.index : undefined;
    const linkage = {
      ...(role === undefined ? {} : { role }),
      ...(description === undefined ? {} : { title: description }),
      ...(toolUseId === undefined ? {} : { toolUseId }),
      ...(parentAgentId === undefined ? {} : { parentAgentId }),
      ...(sessionFile === undefined ? {} : { sessionFile }),
      ...(agentIndex === undefined ? {} : { agentIndex }),
      runId: toolUseId ?? session.turnId ?? payload.id,
      capabilities: OMP_AGENT_READ_ONLY_CAPABILITIES,
    };
    if (payload.status === "started") {
      session.liveSubagents.add(payload.id);
      return this.#emit({
        type: "task.started",
        threadId: session.threadId,
        turnId: session.turnId,
        payload: {
          taskId,
          ...(description === undefined ? {} : { description }),
          ...linkage,
          lifecycle: "running",
          assignmentStatus: "running",
          activityStatus: "working",
        },
      });
    }
    const status =
      payload.status === "completed"
        ? ("completed" as const)
        : payload.status === "failed"
          ? ("failed" as const)
          : payload.status === "aborted"
            ? ("stopped" as const)
            : undefined;
    if (status === undefined) {
      return Effect.void;
    }
    session.liveSubagents.delete(payload.id);
    return this.#emit({
      type: "task.completed",
      threadId: session.threadId,
      turnId: session.turnId,
      payload: {
        taskId,
        status,
        ...linkage,
        lifecycle: status === "stopped" ? "aborted" : "unknown",
        assignmentStatus:
          status === "completed" ? "completed" : status === "failed" ? "failed" : "cancelled",
        ...(typeof payload.result === "string" ? { summary: payload.result } : {}),
        ...(typeof payload.error === "string" ? { error: payload.error } : {}),
        ...(typeof payload.outputFile === "string" ? { outputFile: payload.outputFile } : {}),
      },
    });
  }

  #onSubagentProgress(
    session: LiveAdapterSession,
    frame: Record<string, unknown>,
  ): Effect.Effect<void> {
    const payload = frame.payload;
    if (!isRecord(payload)) {
      return Effect.void;
    }
    const progress = payload.progress;
    if (!isRecord(progress) || typeof progress.id !== "string") {
      return Effect.void;
    }
    const description =
      (typeof progress.task === "string" && progress.task.length > 0 ? progress.task : undefined) ??
      (typeof payload.task === "string" && payload.task.length > 0 ? payload.task : undefined);
    if (description === undefined) {
      return Effect.void;
    }
    const role =
      typeof progress.agent === "string"
        ? progress.agent
        : typeof payload.agent === "string"
          ? payload.agent
          : undefined;
    const toolUseId =
      typeof payload.parentToolCallId === "string" ? payload.parentToolCallId : undefined;
    const parentAgentId =
      typeof payload.parentAgentId === "string" ? payload.parentAgentId : undefined;
    const lastToolName =
      typeof progress.currentTool === "string" ? progress.currentTool : undefined;
    const status = runtimeTaskStatusFromOmpProgress(progress.status);
    const agentIndex = typeof progress.index === "number" ? progress.index : undefined;
    const assignmentStatus = ompAssignmentStatus(progress.status);
    const typedUsage = ompProgressUsage(progress);
    const summary =
      typeof progress.message === "string"
        ? progress.message
        : typeof progress.statusText === "string"
          ? progress.statusText
          : undefined;
    const progressSessionFile =
      typeof payload.sessionFile === "string"
        ? payload.sessionFile
        : typeof progress.sessionFile === "string"
          ? progress.sessionFile
          : undefined;
    return this.#emit({
      type: "task.progress",
      threadId: session.threadId,
      turnId: session.turnId,
      payload: {
        taskId: RuntimeTaskId.make(progress.id),
        description,
        ...(status === undefined ? {} : { status }),
        ...(lastToolName === undefined ? {} : { lastToolName }),
        ...(role === undefined ? {} : { role }),
        ...(toolUseId === undefined ? {} : { toolUseId }),
        ...(agentIndex === undefined ? {} : { agentIndex }),
        runId: toolUseId ?? session.turnId ?? progress.id,
        lifecycle:
          status === "idle" || status === "completed"
            ? "idle"
            : status === "interrupted" || status === "cancelled"
              ? "aborted"
              : "running",
        ...(assignmentStatus === undefined ? {} : { assignmentStatus }),
        activityStatus: ompActivityStatus(progress),
        capabilities: OMP_AGENT_READ_ONLY_CAPABILITIES,
        ...(parentAgentId === undefined ? {} : { parentAgentId }),
        ...(progressSessionFile === undefined ? {} : { sessionFile: progressSessionFile }),
        ...(summary === undefined ? {} : { summary }),
        ...(typedUsage === undefined ? {} : { typedUsage }),
        ...(typeof progress.model === "string" ? { model: progress.model } : {}),
        ...(typeof progress.effort === "string" ? { effort: progress.effort } : {}),
      },
    });
  }

  #onSubagentEvent(
    session: LiveAdapterSession,
    frame: Record<string, unknown>,
  ): Effect.Effect<void> {
    const payload = frame.payload;
    if (!isRecord(payload)) {
      return Effect.void;
    }
    const event = isRecord(payload.event) ? payload.event : payload;
    const eventType = typeof event.type === "string" ? event.type : "";
    if (
      eventType !== "message_end" &&
      eventType !== "tool_execution_end" &&
      eventType !== "agent_end"
    ) {
      return Effect.void;
    }
    const agentId =
      typeof payload.id === "string"
        ? payload.id
        : typeof payload.subagentId === "string"
          ? payload.subagentId
          : typeof frame.subagentId === "string"
            ? frame.subagentId
            : undefined;
    if (agentId === undefined) {
      return Effect.void;
    }
    return this.#emit({
      type: "task.updated",
      threadId: session.threadId,
      turnId: session.turnId,
      payload: {
        taskId: RuntimeTaskId.make(agentId),
        transcriptRevision:
          typeof event.id === "string"
            ? event.id
            : `${eventType}:${++this.#subagentRevision.current}`,
      },
    });
  }

  #onMessageStart(
    session: LiveAdapterSession,
    frame: Record<string, unknown>,
  ): Effect.Effect<void> {
    const message = frame.message;
    if (isRecord(message) && message.role === "custom" && message.customType === "advisor") {
      return this.#onAdvisorMessage(session, message);
    }
    if (!isRecord(message) || message.role !== "assistant") {
      return Effect.void;
    }
    return this.#demoteHeldBackRun(session);
  }

  /**
   * omp advisor cards arrive as message_start frames with role "custom" and
   * customType "advisor". The batched notes live in details.notes; the
   * formatted <advisory> content stays out of the assistant text stream.
   */
  #onAdvisorMessage(
    session: LiveAdapterSession,
    message: Record<string, unknown>,
  ): Effect.Effect<void> {
    const details = message.details;
    if (!isRecord(details) || !Array.isArray(details.notes)) {
      return Effect.void;
    }
    const notes: Array<{
      note: string;
      severity?: "nit" | "concern" | "blocker";
      advisor?: string;
    }> = [];
    for (const entry of details.notes) {
      if (!isRecord(entry) || typeof entry.note !== "string" || entry.note.length === 0) {
        continue;
      }
      const severity =
        entry.severity === "nit" || entry.severity === "concern" || entry.severity === "blocker"
          ? entry.severity
          : undefined;
      const advisor =
        typeof entry.advisor === "string" && entry.advisor.length > 0 ? entry.advisor : undefined;
      notes.push({
        note: entry.note,
        ...(severity === undefined ? {} : { severity }),
        ...(advisor === undefined ? {} : { advisor }),
      });
    }
    if (notes.length === 0) {
      return Effect.void;
    }
    return this.#emit({
      type: "advisor.comment",
      threadId: session.threadId,
      turnId: session.turnId,
      payload: { notes },
    });
  }

  /**
   * Time-traveling stream rule firings arrive as raw session events with a
   * rules array. The wire payload is bounded to name/path/description/
   * condition/scope/interruptMode; the full rule content stays on disk.
   */
  #onTtsrTriggered(
    session: LiveAdapterSession,
    frame: Record<string, unknown>,
  ): Effect.Effect<void> {
    if (!Array.isArray(frame.rules)) {
      return Effect.void;
    }
    const rules: Array<{
      name: string;
      path: string;
      description?: string;
      condition?: string[];
      scope?: string[];
      interruptMode?: "never" | "prose-only" | "tool-only" | "always";
    }> = [];
    for (const rule of frame.rules) {
      if (!isRecord(rule) || typeof rule.name !== "string" || typeof rule.path !== "string") {
        continue;
      }
      const description =
        typeof rule.description === "string" && rule.description.length > 0
          ? rule.description
          : undefined;
      const condition = toRuleStringArray(rule.condition);
      const scope = toRuleStringArray(rule.scope);
      const interruptMode =
        rule.interruptMode === "never" ||
        rule.interruptMode === "prose-only" ||
        rule.interruptMode === "tool-only" ||
        rule.interruptMode === "always"
          ? rule.interruptMode
          : undefined;
      rules.push({
        name: rule.name,
        path: rule.path,
        ...(description === undefined ? {} : { description }),
        ...(condition === undefined ? {} : { condition }),
        ...(scope === undefined ? {} : { scope }),
        ...(interruptMode === undefined ? {} : { interruptMode }),
      });
    }
    if (rules.length === 0) {
      return Effect.void;
    }
    return this.#emit({
      type: "ttsr.triggered",
      threadId: session.threadId,
      turnId: session.turnId,
      payload: { rules },
    });
  }

  #onMessageEnd(session: LiveAdapterSession, frame: Record<string, unknown>): Effect.Effect<void> {
    const message = frame.message;
    if (!isRecord(message) || message.role !== "assistant") {
      return Effect.void;
    }
    session.heldBackRunText = session.openRunText;
    session.openRunText = null;
    return Effect.void;
  }

  #onCommandOutput(
    session: LiveAdapterSession,
    frame: Record<string, unknown>,
  ): Effect.Effect<void> {
    const text = typeof frame.text === "string" ? frame.text : "";
    if (text.length === 0) {
      return Effect.void;
    }
    return this.#emit({
      type: "content.delta",
      threadId: session.threadId,
      turnId: session.turnId,
      payload: {
        streamKind: "status_text",
        delta: text,
      },
    });
  }

  #onMessageUpdate(
    session: LiveAdapterSession,
    frame: Record<string, unknown>,
  ): Effect.Effect<void> {
    const event = frame.assistantMessageEvent;
    if (!isRecord(event) || typeof event.type !== "string") {
      return Effect.void;
    }
    if (event.type === "text_delta") {
      const delta = event.delta;
      if (typeof delta !== "string" || delta.length === 0) {
        return Effect.void;
      }
      session.openRunText = `${session.openRunText ?? ""}${delta}`;
      return Effect.void;
    }
    if (event.type === "thinking_delta") {
      const delta = event.delta;
      if (typeof delta !== "string" || delta.length === 0) {
        return Effect.void;
      }
      return this.#emit({
        type: "content.delta",
        threadId: session.threadId,
        turnId: session.turnId,
        payload: {
          streamKind: "reasoning_text",
          delta,
        },
      });
    }
    if (event.type === "toolcall_end") {
      const toolCall = event.toolCall;
      if (
        !isRecord(toolCall) ||
        typeof toolCall.id !== "string" ||
        typeof toolCall.name !== "string"
      ) {
        return Effect.void;
      }
      return this.#emitToolItemStarted(session, {
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        args: toolCall.arguments,
        intent: typeof toolCall.intent === "string" ? toolCall.intent : undefined,
      });
    }
    return Effect.void;
  }

  #onToolExecutionStart(
    session: LiveAdapterSession,
    frame: Record<string, unknown>,
  ): Effect.Effect<void> {
    if (typeof frame.toolCallId !== "string" || typeof frame.toolName !== "string") {
      return Effect.void;
    }
    return this.#emitToolItemStarted(session, {
      toolCallId: frame.toolCallId,
      toolName: frame.toolName,
      args: frame.args,
      intent: typeof frame.intent === "string" ? frame.intent : undefined,
    });
  }

  #onToolExecutionUpdate(
    session: LiveAdapterSession,
    frame: Record<string, unknown>,
  ): Effect.Effect<void> {
    if (typeof frame.toolCallId !== "string") {
      return Effect.void;
    }
    const delta = formatOmpToolOutputText(frame.partialResult);
    if (delta.length === 0) {
      return Effect.void;
    }
    return this.#emit({
      type: "content.delta",
      threadId: session.threadId,
      turnId: session.turnId,
      itemId: RuntimeItemId.make(frame.toolCallId),
      payload: {
        streamKind: "command_output",
        delta,
      },
    });
  }

  #onToolExecutionEnd(
    session: LiveAdapterSession,
    frame: Record<string, unknown>,
  ): Effect.Effect<void> {
    if (typeof frame.toolCallId !== "string" || typeof frame.toolName !== "string") {
      return Effect.void;
    }
    const toolCallId = frame.toolCallId;
    const toolName = frame.toolName;
    const isError = frame.isError === true;
    const tracked = session.toolCalls.get(toolCallId);
    const args = frame.args !== undefined ? frame.args : tracked?.args;
    const intent = typeof frame.intent === "string" ? frame.intent : tracked?.intent;
    const presentation = presentOmpToolCall({
      toolCallId,
      toolName,
      args,
      intent,
      result: frame.result,
      isError,
    });
    session.toolCalls.delete(toolCallId);
    return this.#emit({
      type: "item.completed",
      threadId: session.threadId,
      turnId: session.turnId,
      itemId: RuntimeItemId.make(toolCallId),
      payload: {
        itemType: presentation.itemType,
        status: isError ? "failed" : "completed",
        title: presentation.title,
        ...(presentation.detail !== undefined ? { detail: presentation.detail } : {}),
        data: presentation.data,
      },
    });
  }

  #emitToolItemStarted(
    session: LiveAdapterSession,
    input: {
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args: unknown;
      readonly intent: string | undefined;
    },
  ): Effect.Effect<void> {
    if (session.toolCalls.has(input.toolCallId)) {
      return Effect.void;
    }
    session.toolCalls.set(input.toolCallId, {
      toolName: input.toolName,
      args: input.args,
      intent: input.intent,
    });
    const presentation = presentOmpToolCall(input);
    return this.#emit({
      type: "item.started",
      threadId: session.threadId,
      turnId: session.turnId,
      itemId: RuntimeItemId.make(input.toolCallId),
      payload: {
        itemType: presentation.itemType,
        status: "inProgress",
        title: presentation.title,
        ...(presentation.detail !== undefined ? { detail: presentation.detail } : {}),
        data: presentation.data,
      },
    });
  }

  #demoteHeldBackRun(session: LiveAdapterSession): Effect.Effect<void> {
    const text = session.heldBackRunText;
    session.heldBackRunText = null;
    if (text === null || text.length === 0) {
      return Effect.void;
    }
    return this.#emit({
      type: "content.delta",
      threadId: session.threadId,
      turnId: session.turnId,
      payload: {
        streamKind: "status_text",
        delta: text,
      },
    });
  }

  #flushFinalAssistantRun(session: LiveAdapterSession): Effect.Effect<void> {
    const text = session.heldBackRunText ?? session.openRunText;
    session.heldBackRunText = null;
    session.openRunText = null;
    if (text === null || text.length === 0) {
      return Effect.void;
    }
    return this.#emit({
      type: "content.delta",
      threadId: session.threadId,
      turnId: session.turnId,
      payload: {
        streamKind: "assistant_text",
        delta: text,
      },
    });
  }

  #emitTurnCompleted(session: LiveAdapterSession): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      yield* this.#flushFinalAssistantRun(session);
      const now = yield* Clock.currentTimeMillis;
      yield* this.#emitTokenUsageFromState(session, now).pipe(Effect.ignore);
      const aborted = session.stopRequested;
      session.stopRequested = false;
      const turnId = session.turnId;
      // Clear the in-flight marker so a later transport end (child exit while
      // idle) cannot emit a spurious turn.aborted for an already-finished turn.
      session.turnId = undefined;
      if (aborted) {
        yield* this.#emit({
          type: "turn.aborted",
          threadId: session.threadId,
          turnId,
          payload: { reason: "user_abort" },
        });
      } else {
        yield* this.#emit({
          type: "turn.completed",
          threadId: session.threadId,
          turnId,
          payload: { state: "completed" },
        });
      }
      // A user stop only settles the parent turn; background subagents (async
      // jobs) keep running on their own decoupled run signal, so Stop must
      // cancel them explicitly. Fall back to terminating the child when the
      // running omp predates `cancel_subagent`.
      if (aborted && session.liveSubagents.size > 0) {
        yield* this.#cancelLiveSubagents(session);
      }
    });
  }

  #cancelLiveSubagents(session: LiveAdapterSession): Effect.Effect<void> {
    const ids = Array.from(session.liveSubagents);
    if (ids.length === 0) {
      return Effect.void;
    }
    return Effect.gen({ self: this }, function* () {
      for (const subagentId of ids) {
        const outcome = yield* Effect.exit(
          this.#send(session.threadId, { type: "cancel_subagent", subagentId }).pipe(
            Effect.timeout(OMP_ABORT_ACK_TIMEOUT),
          ),
        );
        // `cancel_subagent` acknowledges with a response; a `success: false`
        // response means the command is unknown (pre-`cancel_subagent` omp) or
        // the cancel failed. An effect-level failure means the child died. In
        // every non-success case the only way to actually stop the subagents
        // is to terminate the child.
        const cancelled =
          Exit.isSuccess(outcome) && isRecord(outcome.value) && outcome.value.success === true;
        if (!cancelled) {
          yield* this.#onSessionTransportEnded(session);
          return;
        }
      }
    });
  }

  #maybeEmitLiveTokenUsage(session: LiveAdapterSession): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      if (session.turnId === undefined) {
        return;
      }
      const now = yield* Clock.currentTimeMillis;
      if (now - session.lastTokenUsageEmitAtMs < TOKEN_USAGE_EMIT_MIN_INTERVAL_MS) {
        return;
      }
      yield* this.#emitTokenUsageFromState(session, now).pipe(Effect.ignore);
    });
  }

  #emitTokenUsageFromState(
    session: LiveAdapterSession,
    now: number,
  ): Effect.Effect<void, ProviderAdapterProcessError | ProviderAdapterSessionNotFoundError> {
    return Effect.gen({ self: this }, function* () {
      // D2/D3: claim the throttle slot synchronously, before any RPC yield. The
      // slot is consumed even if the emit later fails or early-returns (no tokens).
      session.lastTokenUsageEmitAtMs = now;
      const response = yield* this.#send(session.threadId, { type: "get_state" });
      if (!isRecord(response) || !isRecord(response.data)) {
        return;
      }
      const state = response.data;
      const contextUsage = state.contextUsage;
      if (!isRecord(contextUsage) || typeof contextUsage.tokens !== "number") {
        return;
      }
      const usedTokens = Math.max(0, Math.floor(contextUsage.tokens));
      if (usedTokens <= 0) {
        return;
      }
      const maxTokens =
        typeof contextUsage.contextWindow === "number" && contextUsage.contextWindow > 0
          ? Math.floor(contextUsage.contextWindow)
          : undefined;
      const contextUsedPercent =
        typeof contextUsage.percent === "number" && Number.isFinite(contextUsage.percent)
          ? Math.min(100, Math.max(0, Math.round(contextUsage.percent * 10) / 10))
          : undefined;
      const tokensPerSecond =
        typeof state.tokensPerSecond === "number" && Number.isFinite(state.tokensPerSecond)
          ? state.tokensPerSecond
          : undefined;
      const queuedMessageCount =
        typeof state.queuedMessageCount === "number" && state.queuedMessageCount >= 0
          ? Math.floor(state.queuedMessageCount)
          : undefined;
      const statsResponse = yield* this.#send(session.threadId, { type: "get_session_stats" }).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      const stats =
        statsResponse !== undefined && isRecord(statsResponse) && isRecord(statsResponse.data)
          ? statsResponse.data
          : undefined;
      const tokens = stats !== undefined && isRecord(stats.tokens) ? stats.tokens : undefined;
      yield* this.#emit({
        type: "thread.token-usage.updated",
        threadId: session.threadId,
        turnId: session.turnId,
        payload: {
          usage: {
            usedTokens,
            ...(maxTokens === undefined ? {} : { maxTokens }),
            ...(contextUsedPercent === undefined ? {} : { contextUsedPercent }),
            ...(tokensPerSecond === undefined ? {} : { tokensPerSecond }),
            ...(queuedMessageCount === undefined ? {} : { queuedMessageCount }),
            ...(tokens !== undefined && typeof tokens.input === "number"
              ? { inputTokens: Math.max(0, Math.floor(tokens.input)) }
              : {}),
            ...(tokens !== undefined && typeof tokens.output === "number"
              ? { outputTokens: Math.max(0, Math.floor(tokens.output)) }
              : {}),
            ...(tokens !== undefined && typeof tokens.reasoning === "number"
              ? { reasoningOutputTokens: Math.max(0, Math.floor(tokens.reasoning)) }
              : {}),
            ...(stats !== undefined && typeof stats.toolUses === "number"
              ? { toolUses: Math.max(0, Math.floor(stats.toolUses)) }
              : {}),
            ...(stats !== undefined && typeof stats.durationMs === "number"
              ? { durationMs: Math.max(0, Math.floor(stats.durationMs)) }
              : {}),
          },
        },
      });
    });
  }

  #applyTurnOptions(
    threadId: ThreadId,
    options: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }> | undefined,
  ) {
    return Effect.gen({ self: this }, function* () {
      if (options === undefined) {
        return;
      }
      for (const option of options) {
        if (
          (option.id === "effort" ||
            option.id === "thinking" ||
            option.id === "reasoningEffort" ||
            option.id === "thinkingLevel") &&
          typeof option.value === "string"
        ) {
          yield* this.#send(threadId, { type: "set_thinking_level", level: option.value });
        }
        if (option.id === "fastMode" && typeof option.value === "boolean") {
          yield* this.#send(threadId, { type: "set_fast_mode", enabled: option.value });
        }
      }
    });
  }

  #onHostUriRequest(
    session: LiveAdapterSession,
    frame: Record<string, unknown>,
  ): Effect.Effect<void> {
    if (typeof frame.id !== "string" || frame.id.length === 0) {
      return Effect.void;
    }
    const operation = frame.operation === "write" ? "write" : "read";
    const url = typeof frame.url === "string" ? frame.url : "";
    const title = operation === "write" ? "Accept proposed edit" : "Allow host URI read";
    const detail = url.length > 0 ? `${title}\n${url}` : title;
    session.pendingUiRequests.set(frame.id, { kind: "host_uri", ompId: frame.id });
    return this.#emit({
      type: "request.opened",
      threadId: session.threadId,
      turnId: session.turnId,
      requestId: RuntimeRequestId.make(frame.id),
      payload: {
        requestType: operation === "write" ? "file_change_approval" : "file_read_approval",
        detail,
      },
    });
  }

  #onHostUriCancel(
    session: LiveAdapterSession,
    frame: Record<string, unknown>,
  ): Effect.Effect<void> {
    const targetId = typeof frame.targetId === "string" ? frame.targetId : undefined;
    if (targetId === undefined) {
      return Effect.void;
    }
    const pending = session.pendingUiRequests.get(targetId);
    if (!pending || pending.kind !== "host_uri") {
      return Effect.void;
    }
    session.pendingUiRequests.delete(targetId);
    return this.#emit({
      type: "request.resolved",
      threadId: session.threadId,
      turnId: session.turnId,
      requestId: RuntimeRequestId.make(targetId),
      payload: { requestType: "file_change_approval", decision: "cancel" },
    });
  }

  #applyInteractionMode(session: LiveAdapterSession, mode: ProviderInteractionMode | undefined) {
    return Effect.gen({ self: this }, function* () {
      if (mode === undefined || mode === session.interactionMode) {
        return;
      }
      if (mode === "plan") {
        session.prePlanModelSlug = yield* this.#readCurrentModelSlug(session.threadId);
        const planSlug = yield* this.#resolveRoleModel("plan");
        if (planSlug !== undefined) {
          yield* this.#applyModelSelection(session.threadId, planSlug);
        }
        session.interactionMode = "plan";
        return;
      }
      const restoreSlug = session.prePlanModelSlug;
      session.prePlanModelSlug = undefined;
      session.interactionMode = "default";
      if (restoreSlug !== undefined) {
        yield* this.#applyModelSelection(session.threadId, restoreSlug);
      }
    });
  }

  #readCurrentModelSlug(threadId: ThreadId) {
    return Effect.gen({ self: this }, function* () {
      const response = yield* this.#send(threadId, { type: "get_state" });
      if (!isRecord(response) || !isRecord(response.data)) {
        return undefined;
      }
      const model = response.data.model;
      if (!isRecord(model)) {
        return undefined;
      }
      if (typeof model.provider !== "string" || typeof model.id !== "string") {
        return undefined;
      }
      return `${model.provider}/${model.id}`;
    });
  }

  #applyModelSelection(threadId: ThreadId, model: string | undefined) {
    return Effect.gen({ self: this }, function* () {
      if (model === undefined) {
        return;
      }
      const parsed = parseOmpModelSlug(model);
      if (!parsed) {
        yield* this.#clearLiveSession(threadId);
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "set_model",
          detail: `invalid omp model slug: ${model}`,
        });
      }
      const exit = yield* Effect.exit(
        this.#send(threadId, {
          type: "set_model",
          provider: parsed.provider,
          modelId: parsed.modelId,
        }),
      );
      if (Exit.isFailure(exit)) {
        yield* this.#clearLiveSession(threadId);
        const cause = Cause.squash(exit.cause);
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "set_model",
          detail: cause instanceof Error ? cause.message : String(cause),
        });
      }
    });
  }

  #send(threadId: ThreadId, command: Record<string, unknown>) {
    return this.#runtime
      .send(threadId, command)
      .pipe(Effect.mapError((cause) => mapOmpSpawnError(threadId, cause)));
  }

  #onSessionTransportEnded(session: LiveAdapterSession): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      if (this.#sessions.get(session.threadId) !== session) {
        // Session was already cleared (deliberate teardown or a racing stop);
        // do not double-settle.
        return;
      }
      const turnId = session.turnId;
      session.turnId = undefined;
      const stopRequested = session.stopRequested;
      session.stopRequested = false;
      if (turnId !== undefined) {
        yield* this.#emit({
          type: "turn.aborted",
          threadId: session.threadId,
          turnId,
          payload: { reason: stopRequested ? "user_abort" : "provider_exited" },
        });
      }
      yield* this.#emit({
        type: "session.exited",
        threadId: session.threadId,
        ...(turnId === undefined ? {} : { turnId }),
        payload: {
          reason: stopRequested
            ? "omp child exited before confirming the requested stop"
            : "omp rpc child exited unexpectedly",
          exitKind: "error",
        },
      });
      yield* this.#clearLiveSession(session.threadId);
    });
  }

  #clearLiveSession(threadId: ThreadId) {
    return Effect.gen({ self: this }, function* () {
      const session = this.#sessions.get(threadId);
      this.#sessions.delete(threadId);
      if (session) {
        yield* Scope.close(session.scope, Exit.void).pipe(Effect.ignore);
      }
      yield* this.#runtime.dispose(threadId);
    });
  }

  #onExtensionUiRequest(
    session: LiveAdapterSession,
    frame: Record<string, unknown>,
  ): Effect.Effect<void> {
    const method = frame.method;
    if (method === "open_url") {
      const handler = session.onOpenUrl;
      if (handler && typeof frame.url === "string" && frame.url.length > 0) {
        return handler({
          url: frame.url,
          ...(typeof frame.launchUrl === "string" ? { launchUrl: frame.launchUrl } : {}),
          ...(typeof frame.instructions === "string" ? { instructions: frame.instructions } : {}),
        });
      }
      return Effect.void;
    }
    if (method === "cancel") {
      const targetId = typeof frame.targetId === "string" ? frame.targetId : undefined;
      if (targetId === undefined) {
        return Effect.void;
      }
      const pending = session.pendingUiRequests.get(targetId);
      if (!pending) {
        return Effect.void;
      }
      session.pendingUiRequests.delete(targetId);
      if (pending.kind === "confirm") {
        return this.#emit({
          type: "request.resolved",
          threadId: session.threadId,
          turnId: session.turnId,
          requestId: RuntimeRequestId.make(targetId),
          payload: {
            requestType: "command_execution_approval",
            decision: "cancel",
          },
        });
      }
      return this.#emit({
        type: "user-input.resolved",
        threadId: session.threadId,
        turnId: session.turnId,
        requestId: RuntimeRequestId.make(targetId),
        payload: { answers: {} },
      });
    }
    if (method === "notify") {
      const message = typeof frame.message === "string" ? frame.message : undefined;
      if (message === undefined || message.length === 0) {
        return Effect.void;
      }
      return this.#emit({
        type: "runtime.warning",
        threadId: session.threadId,
        turnId: session.turnId,
        payload: { message },
      });
    }
    if (typeof frame.id !== "string" || frame.id.length === 0) {
      return Effect.void;
    }
    if (method === "confirm") {
      const title = typeof frame.title === "string" ? frame.title : "Confirm";
      const message = typeof frame.message === "string" ? frame.message : "";
      const detail = message.length > 0 ? `${title}\n${message}` : title;
      session.pendingUiRequests.set(frame.id, { kind: "confirm", ompId: frame.id });
      return this.#emit({
        type: "request.opened",
        threadId: session.threadId,
        turnId: session.turnId,
        requestId: RuntimeRequestId.make(frame.id),
        payload: {
          requestType: "command_execution_approval",
          detail,
        },
      });
    }
    if (method === "select") {
      const title = typeof frame.title === "string" ? frame.title : "Select";
      const options = Array.isArray(frame.options)
        ? frame.options.filter((option): option is string => typeof option === "string")
        : [];
      session.pendingUiRequests.set(frame.id, { kind: "select", ompId: frame.id });
      return this.#emit({
        type: "user-input.requested",
        threadId: session.threadId,
        turnId: session.turnId,
        requestId: RuntimeRequestId.make(frame.id),
        payload: {
          questions: [
            {
              id: "choice",
              header: title,
              question: title,
              options: options.map((option) => ({ label: option, description: option })),
            },
          ],
        },
      });
    }
    if (method === "input" || method === "editor") {
      const title = typeof frame.title === "string" ? frame.title : "Input";
      const placeholder =
        typeof frame.placeholder === "string"
          ? frame.placeholder
          : typeof frame.prefill === "string"
            ? frame.prefill
            : "";
      session.pendingUiRequests.set(frame.id, {
        kind: method === "editor" ? "editor" : "input",
        ompId: frame.id,
      });
      return this.#emit({
        type: "user-input.requested",
        threadId: session.threadId,
        turnId: session.turnId,
        requestId: RuntimeRequestId.make(frame.id),
        payload: {
          questions: [
            {
              id: "input",
              header: title,
              question: placeholder.length > 0 ? placeholder : title,
              options: [],
            },
          ],
        },
      });
    }
    return Effect.void;
  }

  #emit(
    event: Omit<ProviderRuntimeEvent, "eventId" | "provider" | "createdAt"> & {
      readonly turnId?: TurnId | undefined;
    },
  ): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const createdAt = yield* nowIso;
      const eventId = yield* this.#randomUUID.pipe(Effect.map(EventId.make));
      const { turnId, ...rest } = event;
      yield* Queue.offer(this.#events, {
        ...rest,
        eventId,
        provider: PROVIDER,
        createdAt,
        ...(turnId === undefined ? {} : { turnId }),
      } as ProviderRuntimeEvent);
    });
  }
}

function firstUserInputAnswer(answers: ProviderUserInputAnswers): string | undefined {
  for (const value of Object.values(answers)) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
    if (Array.isArray(value)) {
      const first = value.find((entry) => typeof entry === "string" && entry.length > 0);
      if (typeof first === "string") {
        return first;
      }
    }
  }
  return undefined;
}

function parseOmpModelSlug(slug: string): { provider: string; modelId: string } | null {
  const slash = slug.indexOf("/");
  if (slash <= 0 || slash === slug.length - 1) {
    return null;
  }
  return { provider: slug.slice(0, slash), modelId: slug.slice(slash + 1) };
}

function runtimeTaskStatusFromOmpProgress(status: unknown): RuntimeTaskStatus | undefined {
  switch (status) {
    case "pending":
    case "running":
    case "waiting":
    case "idle":
    case "completed":
    case "failed":
    case "cancelled":
      return status;
    case "aborted":
      return "interrupted";
    default:
      return undefined;
  }
}

function isLocalOnlyPromptResponse(response: object): boolean {
  return isRecord(response) && isRecord(response.data) && response.data.agentInvoked === false;
}

function ompToolKind(toolName: string): string | undefined {
  const name = toolName.toLowerCase();
  if (name === "bash" || name === "shell" || name === "execute") {
    return "execute";
  }
  if (name === "read") {
    return "read";
  }
  if (
    name === "write" ||
    name === "edit" ||
    name === "multiedit" ||
    name.includes("patch") ||
    name.includes("edit")
  ) {
    return "edit";
  }
  if (name.includes("web_search") || name === "websearch" || name === "grep" || name === "find") {
    return "search";
  }
  return undefined;
}

function ompToolItemType(toolName: string): CanonicalItemType {
  const name = toolName.toLowerCase();
  const kind = ompToolKind(toolName);
  if (kind === "execute") {
    return "command_execution";
  }
  if (kind === "edit") {
    return "file_change";
  }
  if (name.includes("web_search") || name === "websearch") {
    return "web_search";
  }
  if (name.startsWith("mcp__") || name.startsWith("mcp_")) {
    return "mcp_tool_call";
  }
  if (name === "task" || name.includes("collab") || name === "agent") {
    return "collab_agent_tool_call";
  }
  // read + other omp tools: dynamic_tool_call + data.kind for UI presentation
  return "dynamic_tool_call";
}

function extractOmpToolCommand(args: unknown): string | undefined {
  if (!isRecord(args) || typeof args.command !== "string") {
    return undefined;
  }
  const command = args.command.trim();
  return command.length > 0 ? command : undefined;
}

function extractOmpToolPath(args: unknown): string | undefined {
  if (!isRecord(args)) {
    return undefined;
  }
  for (const key of ["path", "filePath", "filename", "file", "target"] as const) {
    const value = args[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

/** Unwrap omp AgentToolResult `{ content: [{ type:"text", text }] }` to plain text. */
function formatOmpToolOutputText(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (isRecord(value) && Array.isArray(value.content)) {
    const parts: string[] = [];
    for (const entry of value.content) {
      if (isRecord(entry) && typeof entry.text === "string" && entry.text.length > 0) {
        parts.push(entry.text);
      }
    }
    if (parts.length > 0) {
      return parts.join("");
    }
  }
  if (isRecord(value)) {
    if (typeof value.stdout === "string" && value.stdout.length > 0) {
      return value.stdout;
    }
    if (typeof value.text === "string" && value.text.length > 0) {
      return value.text;
    }
  }
  return "";
}

function truncateDetail(value: string, maxLength = 500): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1)}…`;
}

function presentOmpToolCall(input: {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly intent?: string | undefined;
  readonly result?: unknown;
  readonly isError?: boolean;
}): {
  readonly itemType: CanonicalItemType;
  readonly title: string;
  readonly detail: string | undefined;
  readonly data: Record<string, unknown>;
} {
  const kind = ompToolKind(input.toolName);
  const command = extractOmpToolCommand(input.args);
  const path = extractOmpToolPath(input.args);
  const intent =
    typeof input.intent === "string" && input.intent.trim().length > 0
      ? input.intent.trim()
      : undefined;
  const detailSource = intent ?? command ?? path;
  const outputText = formatOmpToolOutputText(input.result);
  return {
    itemType: ompToolItemType(input.toolName),
    title: input.toolName,
    detail: detailSource !== undefined ? truncateDetail(detailSource) : undefined,
    data: {
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      ...(kind === undefined ? {} : { kind }),
      ...(command === undefined ? {} : { command }),
      ...(input.args === undefined ? {} : { rawInput: input.args, args: input.args }),
      ...(path === undefined ? {} : { locations: [{ path }] }),
      ...(outputText.length > 0 ? { rawOutput: { content: outputText } } : {}),
      ...(input.result === undefined ? {} : { result: input.result }),
      ...(input.isError === undefined ? {} : { isError: input.isError }),
    },
  };
}

function loginProvidersFromResponse(
  response: object,
): Effect.Effect<ReadonlyArray<OmpLoginProvider>, ProviderAdapterRequestError> {
  if (!isRecord(response) || !isRecord(response.data) || !Array.isArray(response.data.providers)) {
    return Effect.fail(
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "get_login_providers",
        detail: "response data.providers must be an array",
      }),
    );
  }
  const providers: OmpLoginProvider[] = [];
  for (const entry of response.data.providers) {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      typeof entry.name !== "string" ||
      typeof entry.available !== "boolean" ||
      typeof entry.authenticated !== "boolean"
    ) {
      return Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "get_login_providers",
          detail: "each login provider requires id, name, available, authenticated",
        }),
      );
    }
    providers.push({
      id: entry.id,
      name: entry.name,
      available: entry.available,
      authenticated: entry.authenticated,
    });
  }
  return Effect.succeed(providers);
}

function slashCommandsFromAvailableCommandsResponse(
  response: object,
): Effect.Effect<ReadonlyArray<ServerProviderSlashCommand>, ProviderAdapterRequestError> {
  if (!isRecord(response) || !isRecord(response.data) || !Array.isArray(response.data.commands)) {
    return Effect.fail(
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "get_available_commands",
        detail: "response data.commands must be an array",
      }),
    );
  }
  const commands: ServerProviderSlashCommand[] = [];
  for (const entry of response.data.commands) {
    if (!isRecord(entry) || typeof entry.name !== "string" || entry.name.trim().length === 0) {
      return Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "get_available_commands",
          detail: "each command requires a non-empty name",
        }),
      );
    }
    const name = entry.name.trim().replace(/^\//, "");
    const description =
      typeof entry.description === "string" && entry.description.trim().length > 0
        ? entry.description.trim()
        : undefined;
    const inputHint =
      isRecord(entry.input) &&
      typeof entry.input.hint === "string" &&
      entry.input.hint.trim().length > 0
        ? entry.input.hint.trim()
        : undefined;
    commands.push({
      name,
      ...(description === undefined ? {} : { description }),
      ...(inputHint === undefined ? {} : { input: { hint: inputHint } }),
    });
  }
  return Effect.succeed(commands);
}

function modelsFromAvailableModelsResponse(
  response: object,
): Effect.Effect<ReadonlyArray<ServerProviderModel>, ProviderAdapterRequestError> {
  if (!isRecord(response) || !isRecord(response.data) || !Array.isArray(response.data.models)) {
    return Effect.fail(
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "get_available_models",
        detail: "response data.models must be an array",
      }),
    );
  }
  const models: ServerProviderModel[] = [];
  for (const entry of response.data.models) {
    if (!isRecord(entry) || typeof entry.provider !== "string" || typeof entry.id !== "string") {
      return Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "get_available_models",
          detail: "each model requires provider and id strings",
        }),
      );
    }
    const provider = entry.provider.trim();
    const id = entry.id.trim();
    const slug = `${provider}/${id}`;
    const name =
      typeof entry.name === "string" && entry.name.trim().length > 0 ? entry.name.trim() : slug;
    models.push({
      slug,
      name,
      isCustom: false,
      capabilities: null,
    });
  }
  return Effect.succeed(models);
}

const OMP_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
