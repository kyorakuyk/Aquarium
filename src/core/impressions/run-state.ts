export interface ImpressionsRunStateSnapshot {
  running: boolean;
  completedAt: number | null;
}

export interface ImpressionsRunStateEvent extends ImpressionsRunStateSnapshot {
  sessionId: string;
}

export interface ImpressionsRunStateOptions {
  now?: () => number;
  onError?: (error: unknown) => void;
}

export interface ImpressionsRunState {
  tryAcquire(sessionId: string): (() => void) | undefined;
  isRunning(sessionId: string): boolean;
  status(sessionId: string): ImpressionsRunStateSnapshot;
  subscribe(listener: (event: ImpressionsRunStateEvent) => void): () => void;
}

export function createImpressionsRunState(options: ImpressionsRunStateOptions = {}): ImpressionsRunState {
  const now = options.now ?? Date.now;
  const runningSessions = new Set<string>();
  const completedAtBySession = new Map<string, number>();
  const listeners = new Set<(event: ImpressionsRunStateEvent) => void>();

  function currentStatus(sessionId: string): ImpressionsRunStateSnapshot {
    return {
      running: runningSessions.has(sessionId),
      completedAt: completedAtBySession.get(sessionId) ?? null,
    };
  }

  function emit(event: ImpressionsRunStateEvent): void {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        try {
          options.onError?.(error);
        } catch {
          // 观察者失败不能中断提取任务。
        }
      }
    }
  }

  return {
    tryAcquire(sessionId) {
      if (runningSessions.has(sessionId)) return undefined;
      runningSessions.add(sessionId);
      emit({ sessionId, ...currentStatus(sessionId) });
      let released = false;
      return () => {
        if (released) return;
        released = true;
        runningSessions.delete(sessionId);
        completedAtBySession.set(sessionId, now());
        emit({ sessionId, ...currentStatus(sessionId) });
      };
    },
    isRunning: (sessionId) => runningSessions.has(sessionId),
    status: currentStatus,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
