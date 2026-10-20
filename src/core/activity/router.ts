import { createActivityBatcher, type ActivityBatch } from './batcher.ts';
import { sessionId, type IncomingMessage } from '../shared/events.ts';
import type { SessionQueue } from '../conversation/session-queue.ts';

export interface RoutedActivityOptions {
  batched?: true;
  activityBatch?: ActivityBatch<IncomingMessage>;
}

export interface ActivityMessageRouterOptions<Timer> {
  now: () => number;
  setTimer: (callback: () => void, delayMs: number) => Timer;
  clearTimer: (timer: Timer) => void;
  queue: SessionQueue;
  shouldBatch: (message: IncomingMessage) => boolean;
  processMessage: (message: IncomingMessage, options: RoutedActivityOptions) => Promise<unknown>;
  onError?: (error: unknown, message: IncomingMessage) => void;
}

export interface ActivityMessageRouter {
  route(message: IncomingMessage): void;
  close(): void;
}

export function createActivityMessageRouter<Timer>(
  options: ActivityMessageRouterOptions<Timer>,
): ActivityMessageRouter {
  let closed = false;

  function report(error: unknown, message: IncomingMessage): void {
    try {
      options.onError?.(error, message);
    } catch {
      // Reporting an error must not block later messages in this session.
    }
  }

  async function processSafely(
    message: IncomingMessage,
    dispatchOptions: RoutedActivityOptions,
  ): Promise<void> {
    try {
      await options.processMessage(message, dispatchOptions);
    } catch (error) {
      report(error, message);
    }
  }

  function enqueue(sessionKey: string, fallbackMessage: IncomingMessage, task: () => Promise<void>): void {
    void options.queue.run(sessionKey, task).catch((error: unknown) => report(error, fallbackMessage));
  }

  function enqueueBatch(batch: ActivityBatch<IncomingMessage>): void {
    enqueue(batch.sessionId, batch.latestMessage, async () => {
      const priorMessages = batch.messages.slice(0, -1);
      for (const message of priorMessages) {
        await processSafely(message, { batched: true });
      }
      if (closed) {
        await processSafely(batch.latestMessage, { batched: true });
      } else {
        await processSafely(batch.latestMessage, { activityBatch: batch });
      }
    });
  }

  const batcher = createActivityBatcher<IncomingMessage, Timer>({
    now: options.now,
    setTimer: options.setTimer,
    clearTimer: options.clearTimer,
    onFlush: enqueueBatch,
  });

  return {
    route(message) {
      if (closed) return;
      const key = sessionId(message.session);
      let shouldBatch = false;
      let batchAddFailed = false;
      try {
        shouldBatch = options.shouldBatch(message);
      } catch (error) {
        report(error, message);
      }
      if (shouldBatch) {
        try {
          batcher.add(key, message);
          return;
        } catch (error) {
          batchAddFailed = true;
          report(error, message);
        }
      }

      const pending = batcher.cancel(key);
      const pendingMessages = pending?.messages ?? [];
      const lastPendingMessage = pendingMessages[pendingMessages.length - 1];
      const priorMessages = batchAddFailed && lastPendingMessage === message
        ? pendingMessages.slice(0, -1)
        : pendingMessages;
      enqueue(key, message, async () => {
        for (const batchedMessage of priorMessages) {
          await processSafely(batchedMessage, { batched: true });
        }
        await processSafely(message, {});
      });
    },

    close() {
      if (closed) return;
      closed = true;
      for (const batch of batcher.cancelAll()) {
        enqueue(batch.sessionId, batch.latestMessage, async () => {
          for (const message of batch.messages) {
            await processSafely(message, { batched: true });
          }
        });
      }
    },
  };
}
