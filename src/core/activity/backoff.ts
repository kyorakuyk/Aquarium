const BACKOFF_START_COUNT = 2;
const INITIAL_BACKOFF_MS = 15_000;
const MAX_BACKOFF_MS = 300_000;
const BACKOFF_BYPASS_BATCH_SIZE = 6;
const MAX_TRACKED_NO_REPLIES = 7;

interface SessionBackoffState {
  consecutiveNoReplies: number;
  lastNoReplyAt: number;
}

export interface IdleBackoff {
  shouldBackoff(sessionId: string, now: number, batchSize: number): boolean;
  recordNoReply(sessionId: string, now: number): void;
  recordReply(sessionId: string): void;
}

export function idleBackoffDelayMs(consecutiveNoReplies: number): number {
  if (!Number.isInteger(consecutiveNoReplies) || consecutiveNoReplies < BACKOFF_START_COUNT) return 0;
  return Math.min(MAX_BACKOFF_MS, INITIAL_BACKOFF_MS * 2 ** (consecutiveNoReplies - BACKOFF_START_COUNT));
}

export function createIdleBackoff(): IdleBackoff {
  const sessions = new Map<string, SessionBackoffState>();

  return {
    shouldBackoff(sessionId, now, batchSize) {
      const state = sessions.get(sessionId);
      if (!state
        || state.consecutiveNoReplies < BACKOFF_START_COUNT
        || batchSize >= BACKOFF_BYPASS_BATCH_SIZE) {
        return false;
      }

      const elapsed = Math.max(0, now - state.lastNoReplyAt);
      return elapsed < idleBackoffDelayMs(state.consecutiveNoReplies);
    },

    recordNoReply(sessionId, now) {
      const previous = sessions.get(sessionId);
      sessions.set(sessionId, {
        consecutiveNoReplies: Math.min(MAX_TRACKED_NO_REPLIES, (previous?.consecutiveNoReplies ?? 0) + 1),
        lastNoReplyAt: now,
      });
    },

    recordReply(sessionId) {
      sessions.delete(sessionId);
    },
  };
}
