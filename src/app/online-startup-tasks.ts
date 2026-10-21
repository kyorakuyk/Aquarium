export type OnlineStartupTaskRunner = (() => Promise<void>) & { close: () => void };

export function createOnlineStartupTasks(options: {
  catchUpHistory: () => Promise<boolean>;
  syncStickers: () => Promise<void>;
  now?: () => number;
  cooldownMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: typeof globalThis.clearTimeout;
  onError?: (error: unknown) => void;
}): OnlineStartupTaskRunner {
  const now = options.now ?? Date.now;
  const cooldownMs = options.cooldownMs ?? 30_000;
  const setTimer = options.setTimer ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
  const clearTimer = options.clearTimer ?? globalThis.clearTimeout;
  let lastSuccessfulAt: number | undefined;
  let inFlight: Promise<void> | undefined;
  let cooldownTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingCooldownRun = false;
  let closed = false;

  function remainingCooldown(): number {
    if (lastSuccessfulAt === undefined) return 0;
    return Math.max(0, cooldownMs - (now() - lastSuccessfulAt));
  }

  function startRun(): Promise<void> {
    if (inFlight) return inFlight;
    const task = Promise.resolve()
      .then(options.catchUpHistory)
      .then(async (succeeded) => {
        if (succeeded) lastSuccessfulAt = now();
        await options.syncStickers();
      });
    let tracked: Promise<void>;
    tracked = task.finally(() => {
      if (inFlight === tracked) inFlight = undefined;
    });
    inFlight = tracked;
    return tracked;
  }

  function schedulePendingRun(): void {
    pendingCooldownRun = true;
    if (cooldownTimer !== undefined) return;
    cooldownTimer = setTimer(() => {
      cooldownTimer = undefined;
      if (closed || !pendingCooldownRun) return;
      const remaining = remainingCooldown();
      if (remaining > 0) {
        schedulePendingRun();
        return;
      }
      pendingCooldownRun = false;
      void startRun().catch((error: unknown) => options.onError?.(error));
    }, remainingCooldown());
  }

  const runOnlineStartupTasks: OnlineStartupTaskRunner = () => {
    if (closed) return Promise.resolve();
    if (inFlight) return inFlight;
    if (remainingCooldown() > 0) {
      schedulePendingRun();
      return Promise.resolve();
    }
    if (cooldownTimer !== undefined) clearTimer(cooldownTimer);
    cooldownTimer = undefined;
    pendingCooldownRun = false;
    return startRun();
  };
  runOnlineStartupTasks.close = () => {
    closed = true;
    if (cooldownTimer !== undefined) clearTimer(cooldownTimer);
    cooldownTimer = undefined;
    pendingCooldownRun = false;
  };

  return runOnlineStartupTasks;
}
