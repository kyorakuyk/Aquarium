const QUIET_WINDOW_MS = 8_000;
const MAX_BATCH_MS = 30_000;

type NonEmptyArray<T> = [T, ...T[]];

export interface ActivityBatch<T> {
  sessionId: string;
  messages: Readonly<NonEmptyArray<T>>;
  latestMessage: T;
  startedAt: number;
  deadlineAt: number;
}

export interface ActivityBatcherOptions<T, Timer> {
  now: () => number;
  setTimer: (callback: () => void, delayMs: number) => Timer;
  clearTimer: (timer: Timer) => void;
  onFlush: (batch: ActivityBatch<T>) => void;
}

export interface ActivityBatcher<T> {
  add(sessionId: string, message: T): void;
  cancel(sessionId: string): ActivityBatch<T> | undefined;
  cancelAll(): ActivityBatch<T>[];
}

interface PendingBatch<T, Timer> {
  sessionId: string;
  messages: T[];
  latestMessage: T;
  startedAt: number;
  deadlineAt: number;
  timer?: Timer;
}

function snapshot<T, Timer>(batch: PendingBatch<T, Timer>): ActivityBatch<T> {
  return {
    sessionId: batch.sessionId,
    messages: batch.messages.slice() as NonEmptyArray<T>,
    latestMessage: batch.latestMessage,
    startedAt: batch.startedAt,
    deadlineAt: batch.deadlineAt,
  };
}

export function createActivityBatcher<T, Timer>(
  options: ActivityBatcherOptions<T, Timer>,
): ActivityBatcher<T> {
  const pending = new Map<string, PendingBatch<T, Timer>>();

  function cancelTimer(batch: PendingBatch<T, Timer>): void {
    if (batch.timer === undefined) return;
    options.clearTimer(batch.timer);
    delete batch.timer;
  }

  function flush(batch: PendingBatch<T, Timer>): void {
    if (pending.get(batch.sessionId) !== batch) return;
    pending.delete(batch.sessionId);
    cancelTimer(batch);
    options.onFlush(snapshot(batch));
  }

  return {
    add(sessionId, message) {
      const receivedAt = options.now();
      let batch = pending.get(sessionId);
      if (batch && receivedAt >= batch.deadlineAt) {
        flush(batch);
        batch = undefined;
      }

      if (!batch) {
        batch = {
          sessionId,
          messages: [],
          latestMessage: message,
          startedAt: receivedAt,
          deadlineAt: receivedAt + MAX_BATCH_MS,
        };
        pending.set(sessionId, batch);
      }

      batch.messages.push(message);
      batch.latestMessage = message;
      batch.deadlineAt = Math.min(receivedAt + QUIET_WINDOW_MS, batch.startedAt + MAX_BATCH_MS);
      cancelTimer(batch);
      batch.timer = options.setTimer(
        () => flush(batch as PendingBatch<T, Timer>),
        Math.max(0, batch.deadlineAt - options.now()),
      );
    },

    cancel(sessionId) {
      const batch = pending.get(sessionId);
      if (!batch) return undefined;
      pending.delete(sessionId);
      cancelTimer(batch);
      return snapshot(batch);
    },

    cancelAll() {
      const batches: ActivityBatch<T>[] = [];
      for (const sessionId of [...pending.keys()]) {
        const batch = pending.get(sessionId);
        if (!batch) continue;
        pending.delete(sessionId);
        cancelTimer(batch);
        batches.push(snapshot(batch));
      }
      return batches;
    },
  };
}
