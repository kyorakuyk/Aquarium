import type { Mode } from './mode.ts';

export type ProactiveMode = Exclude<Mode, 'mention_only'>;

const WINDOW_MS = 60 * 60_000;
const MIN_EXPECTED_JUDGMENTS = 4;
const THRESHOLD_STEP = 0.05;
const MIN_THRESHOLD = 0.2;
const MAX_THRESHOLD = 0.9;
const PROACTIVE_COOLDOWN_MS = 120_000;

const INITIAL_THRESHOLDS: Record<ProactiveMode, number> = {
  natural: 0.5,
  active: 0.35,
  busy: 0.7,
};

const TARGET_FREQUENCIES: Record<ProactiveMode, number> = {
  natural: 0.5,
  active: 1.0,
  busy: 0.2,
};

export function initialThresholdForMode(mode: ProactiveMode): number {
  return INITIAL_THRESHOLDS[mode];
}

interface SessionThresholdState {
  threshold: number;
  expectedAt: number[];
  actualAt: number[];
  lastProactiveReplyAt?: number;
}

export interface ActivityThreshold {
  getThreshold(sessionId: string, mode: ProactiveMode, now: number): number;
  /** Update the expected history and threshold for subsequent decisions only. */
  recordJudgment(sessionId: string, mode: ProactiveMode, probability: number, now: number): void;
  recordProactiveReply(sessionId: string, mode: ProactiveMode, now: number): void;
  isProactiveCooldown(sessionId: string, now: number, cooldownMs?: number): boolean;
}

function createSessionState(mode: ProactiveMode): SessionThresholdState {
  return {
    threshold: INITIAL_THRESHOLDS[mode],
    expectedAt: [],
    actualAt: [],
  };
}

function pruneWindow(timestamps: number[], now: number): number[] {
  const cutoff = now - WINDOW_MS;
  return timestamps.filter((timestamp) => timestamp >= cutoff && timestamp <= now);
}

function roundThreshold(value: number): number {
  return Math.round(value * 100) / 100;
}

export function adjustThresholdForTalk(threshold: number, effectiveTalk: number, energy = 1): number {
  return Math.max(MIN_THRESHOLD, Math.min(
    MAX_THRESHOLD,
    roundThreshold(threshold - 0.05 * effectiveTalk + (energy < 0.25 ? 0.1 : 0)),
  ));
}

export function createActivityThreshold(): ActivityThreshold {
  const sessions = new Map<string, SessionThresholdState>();

  function findSession(sessionId: string, now: number): SessionThresholdState | undefined {
    const state = sessions.get(sessionId);
    if (!state) return undefined;

    state.expectedAt = pruneWindow(state.expectedAt, now);
    state.actualAt = pruneWindow(state.actualAt, now);
    if (state.lastProactiveReplyAt !== undefined
      && now - state.lastProactiveReplyAt >= WINDOW_MS) {
      delete state.lastProactiveReplyAt;
    }
    if (state.expectedAt.length === 0 && state.actualAt.length === 0
      && state.lastProactiveReplyAt === undefined) {
      sessions.delete(sessionId);
      return undefined;
    }
    return state;
  }

  function getOrCreateSession(
    sessionId: string,
    mode: ProactiveMode,
    now: number,
  ): SessionThresholdState {
    const state = findSession(sessionId, now) ?? createSessionState(mode);
    if (state.expectedAt.length < MIN_EXPECTED_JUDGMENTS) {
      state.threshold = INITIAL_THRESHOLDS[mode];
    }
    sessions.set(sessionId, state);
    return state;
  }

  return {
    getThreshold(sessionId, mode, now) {
      const state = findSession(sessionId, now);
      if (!state || state.expectedAt.length < MIN_EXPECTED_JUDGMENTS) {
        if (state) state.threshold = INITIAL_THRESHOLDS[mode];
        return INITIAL_THRESHOLDS[mode];
      }
      return state.threshold;
    },

    recordJudgment(sessionId, mode, probability, now) {
      const state = getOrCreateSession(sessionId, mode, now);
      if (probability >= 0.5) state.expectedAt.push(now);

      const expected = state.expectedAt.length;
      if (expected < MIN_EXPECTED_JUDGMENTS) {
        state.threshold = INITIAL_THRESHOLDS[mode];
      } else {
        const targetReplies = expected * TARGET_FREQUENCIES[mode];
        if (state.actualAt.length > targetReplies) {
          state.threshold = Math.min(MAX_THRESHOLD, roundThreshold(state.threshold + THRESHOLD_STEP));
        } else if (state.actualAt.length < targetReplies) {
          state.threshold = Math.max(MIN_THRESHOLD, roundThreshold(state.threshold - THRESHOLD_STEP));
        }
      }
    },

    recordProactiveReply(sessionId, mode, now) {
      const state = getOrCreateSession(sessionId, mode, now);
      state.actualAt.push(now);
      state.lastProactiveReplyAt = now;
    },

    isProactiveCooldown(sessionId, now, cooldownMs = PROACTIVE_COOLDOWN_MS) {
      if (cooldownMs <= 0) return false;
      const state = findSession(sessionId, now);
      return state?.lastProactiveReplyAt !== undefined
        && now - state.lastProactiveReplyAt < cooldownMs;
    },
  };
}
