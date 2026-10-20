export interface SessionQueue {
  run<T>(sessionId: string, task: () => Promise<T>): Promise<T>;
  idle(): Promise<void>;
}

export function createSessionQueue(): SessionQueue {
  const tails = new Map<string, Promise<void>>();

  return {
    run<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
      const previous = tails.get(sessionId) ?? Promise.resolve();
      const result = previous.then(task);
      const tail = result.then(() => undefined, () => undefined);
      tails.set(sessionId, tail);
      void tail.then(() => {
        if (tails.get(sessionId) === tail) tails.delete(sessionId);
      });
      return result;
    },
    async idle() {
      while (tails.size > 0) {
        await Promise.all([...tails.values()]);
      }
    },
  };
}
