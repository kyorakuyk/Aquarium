import { sessionId, type SessionKey } from './events.ts';

export interface RateLimits {
  perUserPerMinute: number;
  perSessionPerMinute: number;
  minIntervalSec: number;
}

export type RateLimitReason = 'per_user_per_minute' | 'per_session_per_minute' | 'min_interval';

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; reason: RateLimitReason };

export interface RateLimiter {
  check(session: SessionKey, senderId: number, limits: RateLimits): RateLimitResult;
  preview(session: SessionKey, senderId: number, limits: RateLimits): RateLimitResult;
  clear(): void;
}

function activeEvents(events: Map<string, number[]>, key: string, now: number): number[] {
  const cutoff = now - 60_000;
  const active = (events.get(key) ?? []).filter((time) => time > cutoff);
  if (active.length === 0) events.delete(key);
  else events.set(key, active);
  return active;
}

function rateLimitResult(
  userTimes: number[],
  sessionTimes: number[],
  lastSessionTime: number | undefined,
  currentTime: number,
  limits: RateLimits,
): RateLimitResult {
  if (userTimes.length >= limits.perUserPerMinute) {
    return { allowed: false, reason: 'per_user_per_minute' };
  }
  if (sessionTimes.length >= limits.perSessionPerMinute) {
    return { allowed: false, reason: 'per_session_per_minute' };
  }
  if (lastSessionTime !== undefined
    && currentTime - lastSessionTime < limits.minIntervalSec * 1_000) {
    return { allowed: false, reason: 'min_interval' };
  }
  return { allowed: true };
}

export function createRateLimiter(now: () => number = Date.now): RateLimiter {
  const userEvents = new Map<string, number[]>();
  const sessionEvents = new Map<string, number[]>();
  const lastSessionTimes = new Map<string, number>();

  return {
    check(session, senderId, limits) {
      const currentTime = now();
      const currentSessionId = sessionId(session);
      const userKey = `${session.account}:${senderId}`;
      const userTimes = activeEvents(userEvents, userKey, currentTime);
      const sessionTimes = activeEvents(sessionEvents, currentSessionId, currentTime);
      const lastSessionTime = lastSessionTimes.get(currentSessionId);
      const result = rateLimitResult(userTimes, sessionTimes, lastSessionTime, currentTime, limits);
      if (!result.allowed) return result;

      userTimes.push(currentTime);
      sessionTimes.push(currentTime);
      userEvents.set(userKey, userTimes);
      sessionEvents.set(currentSessionId, sessionTimes);
      lastSessionTimes.set(currentSessionId, currentTime);
      return result;
    },

    preview(session, senderId, limits) {
      const currentTime = now();
      const currentSessionId = sessionId(session);
      const userKey = `${session.account}:${senderId}`;
      const cutoff = currentTime - 60_000;
      const userTimes = (userEvents.get(userKey) ?? []).filter((time) => time > cutoff);
      const sessionTimes = (sessionEvents.get(currentSessionId) ?? []).filter((time) => time > cutoff);
      return rateLimitResult(
        userTimes,
        sessionTimes,
        lastSessionTimes.get(currentSessionId),
        currentTime,
        limits,
      );
    },

    clear() {
      userEvents.clear();
      sessionEvents.clear();
      lastSessionTimes.clear();
    },
  };
}
