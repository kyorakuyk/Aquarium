import type { ProtocolAdapter } from '../../adapters/types.ts';
import type { AquariumConfig } from '../../config/schema.ts';
import type { StoreRepository } from '../../store/repository.ts';
import { listEnabledSessions } from '../conversation/sessions.ts';
import { sessionId, type SessionKey } from '../shared/events.ts';
import { sleepPlan } from './index.ts';

const TICK_INTERVAL_MS = 60_000;
const RECENT_BOT_ACTIVITY_MS = 2 * 60 * 60_000;
const MAX_GOODNIGHT_SESSIONS = 2;

export interface SleepGoodnightSchedulerOptions {
  getConfig: () => AquariumConfig;
  adapters: () => readonly ProtocolAdapter[];
  repository: StoreRepository;
  getGoodnightLines: () => readonly string[];
  sendGoodnight: (session: SessionKey, text: string, cycleKey: string) => Promise<boolean>;
  now?: () => number;
  random?: () => number;
  onError?: (error: unknown) => void;
}

export interface SleepGoodnightScheduler {
  tick(): Promise<void>;
  start(): () => void;
}

export function createSleepGoodnightScheduler(options: SleepGoodnightSchedulerOptions): SleepGoodnightScheduler {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  let previousAsleep: boolean | undefined;
  let handledCycleKey: string | undefined;
  let running = false;
  let stopped = false;

  async function tick(): Promise<void> {
    if (running || stopped) return;
    running = true;
    try {
      const config = options.getConfig();
      if (!config.sleep.enabled || !config.sleep.goodnight) {
        previousAsleep = undefined;
        handledCycleKey = undefined;
        return;
      }

      const currentTime = now();
      const plan = sleepPlan(currentTime, config.sleep.bedtime, config.sleep.wake);
      if (!plan.asleep) {
        previousAsleep = false;
        return;
      }
      if (previousAsleep === undefined) {
        previousAsleep = true;
        handledCycleKey = plan.cycleKey;
        return;
      }
      const transitionedToSleep = previousAsleep === false && handledCycleKey !== plan.cycleKey;
      previousAsleep = true;
      if (!transitionedToSleep) return;
      handledCycleKey = plan.cycleKey;

      const cutoff = currentTime - RECENT_BOT_ACTIVITY_MS;
      const candidates = new Map<string, { session: SessionKey; lastSentAt: number }>();
      for (const adapter of options.adapters()) {
        const sessions = await listEnabledSessions(adapter, config, (error) => options.onError?.(error));
        if (stopped) return;
        for (const session of sessions) {
          const id = sessionId(session);
          const lastMessage = options.repository.lastSelfMessage(id);
          if (!lastMessage || lastMessage.time < cutoff || lastMessage.time > currentTime) continue;
          candidates.set(id, { session, lastSentAt: lastMessage.time });
        }
      }

      const lines = options.getGoodnightLines().filter((line) => line.trim().length > 0);
      if (lines.length === 0) return;
      const selected = [...candidates.values()]
        .sort((left, right) => right.lastSentAt - left.lastSentAt
          || sessionId(left.session).localeCompare(sessionId(right.session)))
        .slice(0, MAX_GOODNIGHT_SESSIONS);
      for (const candidate of selected) {
        if (stopped) return;
        const index = Math.min(lines.length - 1, Math.max(0, Math.floor(random() * lines.length)));
        try {
          await options.sendGoodnight(candidate.session, lines[index]!, plan.cycleKey);
        } catch (error) {
          options.onError?.(error);
        }
      }
    } finally {
      running = false;
    }
  }

  function start(): () => void {
    void tick().catch((error: unknown) => options.onError?.(error));
    const timer = setInterval(() => {
      void tick().catch((error: unknown) => options.onError?.(error));
    }, TICK_INTERVAL_MS);
    timer.unref?.();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  return { tick, start };
}
