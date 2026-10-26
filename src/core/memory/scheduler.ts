import type { AquariumConfig } from '../../config/schema.ts';

export interface PersonaMemorySchedulerOptions {
  getConfig: () => AquariumConfig;
  runCycle: (cycleKey: string, now: number) => Promise<void>;
  now?: () => number;
  intervalMs?: number;
  onError?: (error: unknown) => void;
}

export interface PersonaMemoryScheduler {
  tick(): Promise<void>;
  onSleep(cycleKey: string, now: number): Promise<void>;
  start(): () => void;
}

function localDateKey(now: number): string {
  const date = new Date(now);
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function createPersonaMemoryScheduler(options: PersonaMemorySchedulerOptions): PersonaMemoryScheduler {
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? 60_000;
  let stopped = false;
  let running = false;
  let handledFixedDate: string | undefined;
  let handledSleepCycleKey: string | undefined;
  let cycleQueue = Promise.resolve();

  function runCycle(cycleKey: string, at: number): Promise<void> {
    const task = cycleQueue.then(() => options.runCycle(cycleKey, at));
    cycleQueue = task.catch(() => undefined);
    return task;
  }

  async function tick(): Promise<void> {
    if (stopped || running) return;
    running = true;
    try {
      const config = options.getConfig();
      if (config.sleep.enabled) {
        handledFixedDate = undefined;
        return;
      }
      const currentTime = now();
      if (!Number.isSafeInteger(currentTime) || currentTime < 0) throw new RangeError('记忆调度时间无效');
      const dateKey = localDateKey(currentTime);
      if (handledFixedDate === dateKey) return;
      const [hourText, minuteText] = config.memory.organizeAt.split(':');
      const scheduled = new Date(currentTime);
      scheduled.setHours(Number(hourText), Number(minuteText), 0, 0);
      if (currentTime < scheduled.getTime()) return;
      handledFixedDate = dateKey;
      await runCycle(dateKey, currentTime);
    } catch (error) {
      try { options.onError?.(error); } catch { /* 错误回调不能影响后续调度。 */ }
    } finally {
      running = false;
    }
  }

  async function onSleep(cycleKey: string, at: number): Promise<void> {
    if (stopped || !options.getConfig().sleep.enabled) return;
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(cycleKey) || !Number.isSafeInteger(at) || at < 0) {
      throw new RangeError('睡眠记忆整理周期无效');
    }
    if (handledSleepCycleKey === cycleKey) return;
    handledSleepCycleKey = cycleKey;
    await runCycle(cycleKey, at);
  }

  function start(): () => void {
    void tick();
    const timer = setInterval(() => { void tick(); }, intervalMs);
    timer.unref?.();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  return { tick, onSleep, start };
}
