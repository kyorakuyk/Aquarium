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
  clear(): void;
}

function activeEvents(events: Map<string, number[]>, key: string, now: number): number[] {
  const cutoff = now - 60_000;
  const active = (events.get(key) ?? []).filter((time) => time > cutoff);
  if (active.length === 0) events.delete(key);
  else events.set(key, active);
  return active;
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

      if (userTimes.length >= limits.perUserPerMinute) {
        return { allowed: false, reason: 'per_user_per_minute' };
      }
      if (sessionTimes.length >= limits.perSessionPerMinute) {
        return { allowed: false, reason: 'per_session_per_minute' };
      }

      const lastSessionTime = lastSessionTimes.get(currentSessionId);
      if (lastSessionTime !== undefined
        && currentTime - lastSessionTime < limits.minIntervalSec * 1_000) {
        return { allowed: false, reason: 'min_interval' };
      }

      userTimes.push(currentTime);
      sessionTimes.push(currentTime);
      userEvents.set(userKey, userTimes);
      sessionEvents.set(currentSessionId, sessionTimes);
      lastSessionTimes.set(currentSessionId, currentTime);
      return { allowed: true };
    },

    clear() {
      userEvents.clear();
      sessionEvents.clear();
      lastSessionTimes.clear();
    },
  };
}
