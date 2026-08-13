const heldThreadKeys = new Set<string>();

/** After a confirmed stop, keep the outbox from auto-draining until the user sends again. */
export function holdThreadOutboxDrain(threadKey: string): void {
  heldThreadKeys.add(threadKey);
}

export function releaseThreadOutboxDrain(threadKey: string): void {
  heldThreadKeys.delete(threadKey);
}

export function isThreadOutboxDrainHeld(threadKey: string): boolean {
  return heldThreadKeys.has(threadKey);
}
