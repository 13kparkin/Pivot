export type FollowUpQueueItem = {
  readonly id: string;
  readonly text: string;
  readonly createdAt: string;
};

export function createFollowUpQueueItem(text: string, now = new Date()): FollowUpQueueItem {
  return {
    id: `follow-up-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    text,
    createdAt: now.toISOString(),
  };
}

export function enqueueFollowUp(
  queue: ReadonlyArray<FollowUpQueueItem>,
  item: FollowUpQueueItem,
): FollowUpQueueItem[] {
  return [...queue, item];
}

export function removeFollowUp(
  queue: ReadonlyArray<FollowUpQueueItem>,
  id: string,
): FollowUpQueueItem[] {
  return queue.filter((item) => item.id !== id);
}

export function dequeueFollowUp(queue: ReadonlyArray<FollowUpQueueItem>): {
  readonly next: FollowUpQueueItem | null;
  readonly remaining: FollowUpQueueItem[];
} {
  if (queue.length === 0) {
    return { next: null, remaining: [] };
  }
  const [next, ...remaining] = queue;
  return { next: next ?? null, remaining };
}

/** Drain only after a successful turn settle — never after interrupt/abort. */
export function shouldDrainFollowUpQueue(input: {
  readonly previousPhase: "disconnected" | "connecting" | "ready" | "running" | null;
  readonly phase: "disconnected" | "connecting" | "ready" | "running";
  readonly latestTurnState: string | null | undefined;
}): boolean {
  if (input.previousPhase !== "running" || input.phase !== "ready") {
    return false;
  }
  return input.latestTurnState === "completed";
}
