import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { classifyTaskAgentKind, ProviderRuntimeEvent } from "./providerRuntime.ts";

const decodeRuntimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);

describe("ProviderRuntimeEvent", () => {
  it("accepts fork-provided driver kinds as branded slugs", () => {
    const parsed = decodeRuntimeEvent({
      type: "session.started",
      eventId: "event-ollama-session",
      provider: "ollama",
      providerInstanceId: "ollama_local",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      payload: {
        message: "started",
      },
    });

    expect(parsed.provider).toBe("ollama");
    expect(parsed.providerInstanceId).toBe("ollama_local");
  });

  it("decodes turn.plan.updated for plan rendering", () => {
    const parsed = decodeRuntimeEvent({
      type: "turn.plan.updated",
      eventId: "event-1",
      provider: "claudeAgent",
      sessionId: "runtime-session-1",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        explanation: "Implement schema updates",
        plan: [
          { step: "Define event union", status: "completed" },
          { step: "Wire adapter mapping", status: "inProgress" },
        ],
      },
    });

    expect(parsed.type).toBe("turn.plan.updated");
    if (parsed.type !== "turn.plan.updated") {
      throw new Error("expected turn.plan.updated");
    }
    expect(parsed.payload.plan).toHaveLength(2);
    expect(parsed.payload.plan[1]?.status).toBe("inProgress");
  });

  it("decodes proposed-plan completion events", () => {
    const parsed = decodeRuntimeEvent({
      type: "turn.proposed.completed",
      eventId: "event-proposed-plan-1",
      provider: "codex",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        planMarkdown: "# Ship it",
      },
    });

    expect(parsed.type).toBe("turn.proposed.completed");
    if (parsed.type !== "turn.proposed.completed") {
      throw new Error("expected turn.proposed.completed");
    }
    expect(parsed.payload.planMarkdown).toBe("# Ship it");
  });

  it("decodes user-input.requested with structured questions", () => {
    const parsed = decodeRuntimeEvent({
      type: "user-input.requested",
      eventId: "event-2",
      provider: "claudeAgent",
      sessionId: "runtime-session-2",
      createdAt: "2026-02-28T00:00:01.000Z",
      threadId: "thread-2",
      requestId: "request-1",
      payload: {
        questions: [
          {
            id: "sandbox_mode",
            header: "Sandbox",
            question: "Which mode should be used?",
            options: [
              {
                label: "workspace-write",
                description: "Allow edits in workspace only",
              },
              {
                label: "danger-full-access",
                description: "Allow unrestricted access",
              },
            ],
          },
        ],
      },
    });

    expect(parsed.type).toBe("user-input.requested");
    if (parsed.type !== "user-input.requested") {
      throw new Error("expected user-input.requested");
    }
    expect(parsed.payload.questions[0]?.id).toBe("sandbox_mode");
    expect(parsed.payload.questions[0]?.options).toHaveLength(2);
  });

  it("decodes user-input.resolved with answer map", () => {
    const parsed = decodeRuntimeEvent({
      type: "user-input.resolved",
      eventId: "event-3",
      provider: "claudeAgent",
      sessionId: "runtime-session-2",
      createdAt: "2026-02-28T00:00:02.000Z",
      threadId: "thread-2",
      requestId: "request-1",
      payload: {
        answers: {
          sandbox_mode: "workspace-write",
        },
      },
    });

    expect(parsed.type).toBe("user-input.resolved");
    if (parsed.type !== "user-input.resolved") {
      throw new Error("expected user-input.resolved");
    }
    expect(parsed.payload.answers.sandbox_mode).toBe("workspace-write");
  });

  it("decodes canonical subagent identity and independent status axes", () => {
    const parsed = decodeRuntimeEvent({
      type: "task.progress",
      eventId: "event-agent-progress-1",
      provider: "omp",
      createdAt: "2026-08-16T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        taskId: "agent-1",
        description: "Inspect repository",
        status: "waiting",
        parentAgentId: "agent-parent",
        runId: "run-1",
        sessionFile: "/tmp/agent-1.jsonl",
        transcriptRevision: "message-12",
        lifecycle: "running",
        assignmentStatus: "running",
        activityStatus: "waiting",
        capabilities: {
          message: false,
          revive: false,
          cancel: false,
          kill: false,
          readOnlyReason: "This OMP version does not expose agent-targeted messaging over RPC.",
        },
      },
    });

    expect(parsed.type).toBe("task.progress");
    if (parsed.type !== "task.progress") {
      throw new Error("expected task.progress");
    }
    expect(parsed.payload.parentAgentId).toBe("agent-parent");
    expect(parsed.payload.runId).toBe("run-1");
    expect(parsed.payload.lifecycle).toBe("running");
    expect(parsed.payload.assignmentStatus).toBe("running");
    expect(parsed.payload.activityStatus).toBe("waiting");
    expect(parsed.payload.capabilities?.message).toBe(false);
  });

  it("rejects legacy message.delta type", () => {
    expect(() =>
      decodeRuntimeEvent({
        type: "message.delta",
        eventId: "event-4",
        provider: "codex",
        sessionId: "runtime-session-3",
        createdAt: "2026-02-28T00:00:03.000Z",
        payload: { delta: "legacy" },
      }),
    ).toThrow();
  });

  it("rejects empty branded canonical ids", () => {
    expect(() =>
      decodeRuntimeEvent({
        type: "runtime.error",
        eventId: "event-5",
        provider: "codex",
        sessionId: "runtime-session-3",
        createdAt: "2026-02-28T00:00:03.000Z",
        threadId: "   ",
        payload: { message: "boom" },
      }),
    ).toThrow();
  });

  it("decodes normalized thread token usage snapshots", () => {
    const parsed = decodeRuntimeEvent({
      type: "thread.token-usage.updated",
      eventId: "event-token-usage-1",
      provider: "claudeAgent",
      createdAt: "2026-02-28T00:00:04.000Z",
      threadId: "thread-1",
      payload: {
        usage: {
          usedTokens: 31251,
          maxTokens: 200000,
          toolUses: 25,
          durationMs: 43567,
        },
      },
    });

    expect(parsed.type).toBe("thread.token-usage.updated");
    if (parsed.type !== "thread.token-usage.updated") {
      throw new Error("expected thread.token-usage.updated");
    }
    expect(parsed.payload.usage.maxTokens).toBe(200000);
    expect(parsed.payload.usage.usedTokens).toBe(31251);
  });

  it("decodes advisor.comment events with severity notes", () => {
    const parsed = decodeRuntimeEvent({
      type: "advisor.comment",
      eventId: "event-advisor-1",
      provider: "omp",
      createdAt: "2026-02-28T00:00:05.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        notes: [
          { note: "Consider extracting this helper", severity: "concern", advisor: "code-review" },
          { note: "Nit: rename this variable", severity: "nit" },
          { note: "This must be fixed before merge", severity: "blocker" },
        ],
      },
    });

    expect(parsed.type).toBe("advisor.comment");
    if (parsed.type !== "advisor.comment") {
      throw new Error("expected advisor.comment");
    }
    expect(parsed.payload.notes).toHaveLength(3);
    expect(parsed.payload.notes[0]?.severity).toBe("concern");
    expect(parsed.payload.notes[0]?.advisor).toBe("code-review");
    expect(parsed.payload.notes[2]?.severity).toBe("blocker");
  });

  it("decodes ttsr.triggered events with bounded rule payloads", () => {
    const parsed = decodeRuntimeEvent({
      type: "ttsr.triggered",
      eventId: "event-ttsr-1",
      provider: "omp",
      createdAt: "2026-02-28T00:00:06.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        rules: [
          {
            name: "codegraph",
            path: "/home/kyle/.omp/agent/rules/codegraph.md",
            description: "Query CodeGraph before searching",
            condition: ["grep-like search"],
            scope: ["server"],
            interruptMode: "always",
          },
        ],
      },
    });

    expect(parsed.type).toBe("ttsr.triggered");
    if (parsed.type !== "ttsr.triggered") {
      throw new Error("expected ttsr.triggered");
    }
    expect(parsed.payload.rules).toHaveLength(1);
    expect(parsed.payload.rules[0]?.name).toBe("codegraph");
    expect(parsed.payload.rules[0]?.path).toBe("/home/kyle/.omp/agent/rules/codegraph.md");
    expect(parsed.payload.rules[0]?.condition).toEqual(["grep-like search"]);
    expect(parsed.payload.rules[0]?.interruptMode).toBe("always");
  });
});

describe("classifyTaskAgentKind", () => {
  it("classifies agent-flavored, watch-loop, and inert types", () => {
    expect(classifyTaskAgentKind({ taskType: "local_agent" })).toBe("agent");
    expect(classifyTaskAgentKind({ taskType: "local_workflow" })).toBe("agent");
    expect(classifyTaskAgentKind({ taskType: undefined })).toBe("agent");
    expect(classifyTaskAgentKind({ taskType: "brand_new_agent_type" })).toBe("agent");
    expect(classifyTaskAgentKind({ taskType: "local_bash" })).toBe("background");
    expect(classifyTaskAgentKind({ taskType: "monitor" })).toBe("background");
    expect(classifyTaskAgentKind({ taskType: "plan" })).toBe("background");
  });

  it("agent-owned tasks are background unless themselves agent-flavored", () => {
    expect(classifyTaskAgentKind({ taskType: "local_bash", agentId: "owner" })).toBe("background");
    expect(classifyTaskAgentKind({ taskType: undefined, agentId: "owner" })).toBe("background");
    // Nested agent: outlives its parent, stays in the roster.
    expect(classifyTaskAgentKind({ taskType: "local_agent", agentId: "owner" })).toBe("agent");
  });
});
