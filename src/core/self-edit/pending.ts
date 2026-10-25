export interface ExpiringEntry {
  expiresAt: number;
}

export function createExpiringStateStore<T extends ExpiringEntry>(now: () => number) {
  const states = new Map<string, T>();
  return {
    get(key: string): T | undefined {
      const state = states.get(key);
      if (!state) return undefined;
      if (now() >= state.expiresAt) {
        states.delete(key);
        return undefined;
      }
      return state;
    },
    set(key: string, state: T): void {
      states.set(key, state);
    },
    delete(key: string): void {
      states.delete(key);
    },
  };
}
