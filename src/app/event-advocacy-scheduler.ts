import type { AquariumConfig } from '../config/schema.ts';
import type { EventAdvocacySendResult } from '../core/privacy/event-advocacy.ts';
import { sessionId } from '../core/shared/events.ts';

interface EventAdvocacyPipeline {
  sendEventAdvocacy(eventId: number): Promise<EventAdvocacySendResult>;
}

interface EventAdvocacySchedulerRepository {
  listConfirmedEventAdvocacies(account: number, limit: number): Array<{ account: number; eventId: number }>;
  getGroupEvent(account: number, eventId: number): { sourceGroupId: number } | undefined;
}

export interface EventAdvocacySchedulerOptions {
  getConfig: () => Pick<AquariumConfig, 'accounts'>;
  repository: EventAdvocacySchedulerRepository;
  getPipeline: (account: number) => EventAdvocacyPipeline | undefined;
  enqueue: (key: string, task: () => Promise<unknown>) => Promise<unknown>;
  intervalMs?: number;
  setInterval?: (callback: () => void, delayMs: number) => ReturnType<typeof setInterval>;
  clearInterval?: (timer: ReturnType<typeof setInterval>) => void;
  onError?: () => void;
}

export interface EventAdvocacyScheduler {
  tick(): Promise<void>;
  start(): () => void;
  close(): void;
}

export function createEventAdvocacyScheduler(
  options: EventAdvocacySchedulerOptions,
): EventAdvocacyScheduler {
  const setIntervalFn = options.setInterval ?? setInterval;
  const clearIntervalFn = options.clearInterval ?? clearInterval;
  const intervalMs = options.intervalMs ?? 60_000;
  const inFlight = new Set<string>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking = false;
  let closed = false;

  async function tick(): Promise<void> {
    if (closed || ticking) return;
    ticking = true;
    const tasks: Promise<unknown>[] = [];
    try {
      for (const accountConfig of options.getConfig().accounts) {
        const account = accountConfig.uin;
        for (const advocacy of options.repository.listConfirmedEventAdvocacies(account, Number.MAX_SAFE_INTEGER)) {
          const pipeline = options.getPipeline(account);
          if (!pipeline) continue;
          const event = options.repository.getGroupEvent(account, advocacy.eventId);
          if (!event) continue;
          const key = sessionId({ account, kind: 'group', peer: event.sourceGroupId });
          const entryKey = `${account}:${advocacy.eventId}`;
          if (inFlight.has(entryKey)) continue;
          inFlight.add(entryKey);
          try {
            const task = options.enqueue(key, () => pipeline.sendEventAdvocacy(advocacy.eventId));
            tasks.push(Promise.resolve(task).catch(() => {
              options.onError?.();
            }).finally(() => inFlight.delete(entryKey)));
          } catch {
            inFlight.delete(entryKey);
            options.onError?.();
          }
        }
      }
      await Promise.all(tasks);
    } finally {
      ticking = false;
    }
  }

  function close(): void {
    closed = true;
    if (timer !== undefined) clearIntervalFn(timer);
    timer = undefined;
  }

  function start(): () => void {
    if (timer !== undefined) return close;
    closed = false;
    timer = setIntervalFn(() => {
      void tick().catch(() => options.onError?.());
    }, intervalMs);
    timer.unref?.();
    void tick().catch(() => options.onError?.());
    return close;
  }

  return { tick, start, close };
}
