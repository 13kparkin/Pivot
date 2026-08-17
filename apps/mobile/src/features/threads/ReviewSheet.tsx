import type {
  EnvironmentId,
  ProjectId,
  ReviewFinding,
  ScopedThreadRef,
  ThreadId,
  VcsStatusResult,
} from "@t3tools/contracts";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  ReviewId,
} from "@t3tools/contracts";
import { deriveReviewFileProgress } from "@t3tools/client-runtime/state/review-progress";
import { useAtomCommand } from "../../state/use-atom-command";
import { threadEnvironment } from "../../state/threads";
import { reviewCommands, useReviewRun } from "../../state/reviewRuns";
import { uuidv4 } from "../../lib/uuid";
import { useMemo, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, Text, View } from "react-native";

const SEVERITY_TONE: Record<string, string> = {
  blocking: "text-red-500",
  "should-fix": "text-amber-500",
  nit: "text-muted-foreground",
};

/** The thread-turn prompt that asks the agent to apply a finding's fix. */
function buildFixPrompt(finding: ReviewFinding): string {
  return [
    "Fix one code review finding in this workspace.",
    `File: ${finding.file}`,
    `Line: ${finding.line === null ? "(file-level)" : String(finding.line)}`,
    `Severity: ${finding.severity}`,
    finding.symbol === null ? null : `Symbol: ${finding.symbol}`,
    `Finding: ${finding.message}`,
    "Apply the minimal change that resolves it. Do not refactor unrelated code. " +
      "Verify the change is coherent.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function severityLabel(severity: string): string {
  switch (severity) {
    case "blocking":
      return "Blocking";
    case "should-fix":
      return "Should fix";
    default:
      return "Nit";
  }
}

export interface ReviewSheetProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly threadRef: ScopedThreadRef;
  /** Working-tree changed files (roster base) from the thread git status. */
  readonly gitStatus: VcsStatusResult | null | undefined;
  readonly visible: boolean;
  readonly onClose: () => void;
}

/**
 * The agent review run sheet: start a working-tree review from the thread,
 * watch per-file progress while it runs, then read findings with Fix with AI
 * (a thread turn). Mirrors the web diff panel's review surface on mobile.
 */
export function ReviewSheet(props: ReviewSheetProps) {
  const [reviewId, setReviewId] = useState<ReviewId | null>(null);
  const [dispatchedFindingIds, setDispatchedFindingIds] = useState<ReadonlySet<string>>(new Set());
  const startReview = useAtomCommand(reviewCommands.start, { reportFailure: false });
  const startThreadTurn = useAtomCommand(threadEnvironment.startTurn, { reportFailure: false });
  const run = useReviewRun(props.environmentId, reviewId);

  const rosterFiles = useMemo(
    () => (props.gitStatus?.workingTree.files ?? []).map((file) => file.path),
    [props.gitStatus],
  );

  const start = () => {
    const nextReviewId = ReviewId.make(uuidv4());
    setReviewId(nextReviewId);
    void startReview({
      environmentId: props.environmentId,
      input: {
        environmentId: props.environmentId,
        reviewId: nextReviewId,
        source: { kind: "working-tree" },
        threadRef: props.threadRef,
        projectId: props.projectId,
      },
    });
  };

  const dispatchFix = (finding: ReviewFinding) => {
    if (dispatchedFindingIds.has(finding.id)) {
      return;
    }
    setDispatchedFindingIds((previous) => new Set(previous).add(finding.id));
    void startThreadTurn({
      environmentId: props.environmentId,
      input: {
        threadId: props.threadId,
        message: {
          messageId: MessageId.make(uuidv4()),
          role: "user",
          text: buildFixPrompt(finding),
          attachments: [],
        },
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        titleSeed: "Fix review finding",
        createdAt: new Date().toISOString(),
      },
    });
  };

  const states = useMemo(
    () =>
      deriveReviewFileProgress({
        files: rosterFiles,
        activity: run?.progress?.activity,
        findings: run?.findings ?? [],
        filesReviewed: run?.filesReviewed,
        status: run?.status ?? "running",
      }),
    [run, rosterFiles],
  );

  return (
    <Modal
      transparent
      statusBarTranslucent
      navigationBarTranslucent
      animationType="slide"
      visible={props.visible}
      onRequestClose={props.onClose}
    >
      <View className="flex-1 justify-end">
        <Pressable className="absolute inset-0 bg-backdrop" onPress={props.onClose} />
        <View className="max-h-[80%] overflow-hidden rounded-t-[24px] border border-b-0 border-border bg-sheet">
          <View className="border-b border-border px-4 py-3">
            <Text className="text-sm font-semibold text-foreground">Review</Text>
          </View>
          {run === null ? (
            <View className="gap-3 px-4 py-4">
              <Text className="text-xs text-muted-foreground">
                Review your uncommitted working-tree changes with an agent.
              </Text>
              <Pressable
                accessibilityRole="button"
                className="items-center rounded-lg bg-foreground px-4 py-2.5"
                onPress={start}
              >
                <Text className="text-sm font-semibold text-background">Review changes</Text>
              </Pressable>
            </View>
          ) : run.status === "failed" ? (
            <View className="px-4 py-4">
              <Text className="text-sm font-semibold text-amber-500">Review failed</Text>
              {run.errorMessage ? (
                <Text className="mt-1 text-xs text-muted-foreground">{run.errorMessage}</Text>
              ) : null}
            </View>
          ) : (
            <ScrollView className="max-h-[60%] px-4 py-3">
              {run.status === "running" ? (
                <View className="mb-3 flex-row items-center gap-2">
                  <ActivityIndicator size="small" />
                  <Text className="text-sm font-medium text-foreground">Reviewing changes…</Text>
                </View>
              ) : (
                <View className="mb-3 flex-row items-center gap-2">
                  <Text
                    className={`text-sm font-semibold ${
                      run.verdict === "approve" ? "text-emerald-500" : "text-amber-500"
                    }`}
                  >
                    {run.verdict === "approve" ? "Approved" : "Changes requested"}
                  </Text>
                  {run.summary ? (
                    <Text className="flex-1 text-xs text-muted-foreground">{run.summary}</Text>
                  ) : null}
                </View>
              )}
              {rosterFiles.length === 0 ? (
                <Text className="text-xs text-muted-foreground">No changed files.</Text>
              ) : (
                rosterFiles.map((filePath) => {
                  const state = states.get(filePath) ?? "pending";
                  const fileFindings = run.findings.filter((finding) => finding.file === filePath);
                  return (
                    <View key={filePath} className="mb-2">
                      <View className="flex-row items-center gap-2">
                        {state === "in-progress" ? (
                          <ActivityIndicator size="small" />
                        ) : state === "done" ? (
                          <Text className="text-sm text-emerald-500">✓</Text>
                        ) : (
                          <Text className="text-sm text-muted-foreground/50">○</Text>
                        )}
                        <Text
                          className={`flex-1 font-mono text-xs ${
                            state === "pending" ? "text-muted-foreground/60" : "text-foreground"
                          }`}
                          numberOfLines={1}
                        >
                          {filePath}
                        </Text>
                        {fileFindings.length > 0 ? (
                          <Text className="text-xs tabular-nums text-muted-foreground">
                            {fileFindings.length}{" "}
                            {fileFindings.length === 1 ? "finding" : "findings"}
                          </Text>
                        ) : null}
                      </View>
                      {fileFindings.map((finding) => (
                        <View
                          key={finding.id}
                          className="ml-6 mt-1 rounded-md border border-border bg-card px-3 py-2"
                        >
                          <View className="flex-row items-center gap-2">
                            <Text
                              className={`text-[11px] font-semibold uppercase ${
                                SEVERITY_TONE[finding.severity] ?? "text-muted-foreground"
                              }`}
                            >
                              {severityLabel(finding.severity)}
                            </Text>
                            <Text className="font-mono text-[11px] text-muted-foreground">
                              {finding.file}
                              {finding.line !== null ? `:${finding.line}` : ""}
                            </Text>
                          </View>
                          <Text className="mt-1 text-xs leading-relaxed text-foreground">
                            {finding.message}
                          </Text>
                          <View className="mt-2 flex-row items-center gap-2">
                            {dispatchedFindingIds.has(finding.id) ? (
                              <Text className="text-[11px] text-muted-foreground">
                                Fix started in thread
                              </Text>
                            ) : (
                              <Pressable
                                accessibilityRole="button"
                                className="rounded-md border border-border bg-card px-2 py-1"
                                onPress={() => dispatchFix(finding)}
                              >
                                <Text className="text-[11px] font-medium text-foreground">
                                  Fix with AI
                                </Text>
                              </Pressable>
                            )}
                          </View>
                        </View>
                      ))}
                    </View>
                  );
                })
              )}
            </ScrollView>
          )}
          <Pressable
            accessibilityRole="button"
            className="border-t border-border px-4 py-3"
            onPress={props.onClose}
          >
            <Text className="text-center text-sm font-medium text-muted-foreground">Close</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}
