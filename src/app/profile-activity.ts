import type { ProfileActivityService } from '../core/profiles/presence-service.ts';

export interface ProfileActivityScheduleOptions {
  service: Pick<ProfileActivityService, 'recomputeSchedules'>;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  onError?: (error: unknown) => void;
}

function delayToNextFourAm(now: number): number {
  const next = new Date(now);
  next.setHours(4, 0, 0, 0);
  if (next.getTime() <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now;
}

export function startProfileActivitySchedule(options: ProfileActivityScheduleOptions): () => void {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const scheduleNext = (): void => {
    if (stopped) return;
    timer = setTimer(run, delayToNextFourAm(now()));
  };
  const run = (): void => {
    if (stopped) return;
    void options.service.recomputeSchedules(now()).catch((error: unknown) => {
      options.onError?.(error);
    }).finally(scheduleNext);
  };

  void options.service.recomputeSchedules(now()).catch((error: unknown) => {
    options.onError?.(error);
  });
  scheduleNext();

  return () => {
    stopped = true;
    if (timer !== undefined) clearTimer(timer);
  };
}
