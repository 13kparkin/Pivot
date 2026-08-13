import { create } from "zustand";
import {
  createFollowUpQueueItem,
  dequeueFollowUp,
  enqueueFollowUp,
  removeFollowUp,
  type FollowUpQueueItem,
} from "./lib/followUpQueue";

type FollowUpQueueStore = {
  readonly queuesByThreadKey: Readonly<Record<string, ReadonlyArray<FollowUpQueueItem>>>;
  enqueue: (threadKey: string, text: string) => FollowUpQueueItem;
  remove: (threadKey: string, id: string) => void;
  dequeue: (threadKey: string) => FollowUpQueueItem | null;
  getQueue: (threadKey: string) => ReadonlyArray<FollowUpQueueItem>;
};

export const useFollowUpQueueStore = create<FollowUpQueueStore>((set, get) => ({
  queuesByThreadKey: {},
  enqueue: (threadKey, text) => {
    const item = createFollowUpQueueItem(text);
    set((state) => ({
      queuesByThreadKey: {
        ...state.queuesByThreadKey,
        [threadKey]: enqueueFollowUp(state.queuesByThreadKey[threadKey] ?? [], item),
      },
    }));
    return item;
  },
  remove: (threadKey, id) => {
    set((state) => {
      const current = state.queuesByThreadKey[threadKey] ?? [];
      const next = removeFollowUp(current, id);
      if (next.length === current.length) {
        return state;
      }
      const queuesByThreadKey = { ...state.queuesByThreadKey };
      if (next.length === 0) {
        delete queuesByThreadKey[threadKey];
      } else {
        queuesByThreadKey[threadKey] = next;
      }
      return { queuesByThreadKey };
    });
  },
  dequeue: (threadKey) => {
    const current = get().queuesByThreadKey[threadKey] ?? [];
    const { next, remaining } = dequeueFollowUp(current);
    if (next === null) {
      return null;
    }
    set((state) => {
      const queuesByThreadKey = { ...state.queuesByThreadKey };
      if (remaining.length === 0) {
        delete queuesByThreadKey[threadKey];
      } else {
        queuesByThreadKey[threadKey] = remaining;
      }
      return { queuesByThreadKey };
    });
    return next;
  },
  getQueue: (threadKey) => get().queuesByThreadKey[threadKey] ?? [],
}));
