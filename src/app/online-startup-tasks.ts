export function createOnlineStartupTasks(options: {
  catchUpHistory: () => Promise<void>;
  syncStickers: () => Promise<void>;
  now?: () => number;
  cooldownMs?: number;
}): () => Promise<void> {
  const now = options.now ?? Date.now;
  const cooldownMs = options.cooldownMs ?? 30_000;
  let lastStartedAt: number | undefined;
  let inFlight: Promise<void> | undefined;

  return function runOnlineStartupTasks(): Promise<void> {
    if (inFlight) return inFlight;
    const startedAt = now();
    if (lastStartedAt !== undefined && startedAt - lastStartedAt < cooldownMs) return Promise.resolve();
    lastStartedAt = startedAt;

    const task = Promise.resolve()
      .then(options.catchUpHistory)
      .then(options.syncStickers);
    let tracked: Promise<void>;
    tracked = task.finally(() => {
      if (inFlight === tracked) inFlight = undefined;
    });
    inFlight = tracked;
    return tracked;
  };
}
