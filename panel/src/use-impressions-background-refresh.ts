import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest } from './api.ts';
import { watchImpressionsRunState, type ImpressionsRunStatus } from './impressions-events.ts';
import { shouldRefreshCompletedExtraction } from './impressions-refresh-model.ts';

export interface TagClassificationStatusView {
  state: 'idle' | 'running' | 'completed' | 'budget' | 'incomplete' | 'error';
  total: number;
  processed: number;
  completedAt: number | null;
}

interface ImpressionsBackgroundRefreshOptions {
  sessionId: string;
  enabled: boolean;
  historyExtractionActive: boolean;
  lastViewLoadStartedAt: { current: number };
  onRefresh: (sessionId: string) => Promise<boolean>;
}

export function useImpressionsBackgroundRefresh({
  sessionId,
  enabled,
  historyExtractionActive,
  lastViewLoadStartedAt,
  onRefresh,
}: ImpressionsBackgroundRefreshOptions): {
  tagClassificationStatus?: TagClassificationStatusView;
  extractionRunning: boolean;
  retryTagClassification: () => Promise<void>;
} {
  const [tagClassificationStatus, setTagClassificationStatus] = useState<TagClassificationStatusView>();
  const [extractionRunning, setExtractionRunning] = useState(false);
  const [tagClassificationRefreshVersion, setTagClassificationRefreshVersion] = useState(0);
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  const retryTagClassification = useCallback(async (): Promise<void> => {
    try {
      const status = await apiRequest<TagClassificationStatusView>('/api/tags/classify', { method: 'POST' });
      setTagClassificationStatus(status);
    } catch (reason) {
      try {
        const status = await apiRequest<TagClassificationStatusView>('/api/tags/classify');
        setTagClassificationStatus(status);
        if (status.state === 'running') return;
      } catch {
        // Keep the original start failure; the status refresh below will retry independently.
      }
      throw reason;
    } finally {
      setTagClassificationRefreshVersion((version) => version + 1);
    }
  }, []);

  useEffect(() => {
    if (!enabled || !sessionId) return;
    let active = true;
    let inFlight = false;
    let timer = 0;
    let wasRunning = false;

    const refreshStatus = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      try {
        const status = await apiRequest<TagClassificationStatusView>('/api/tags/classify');
        if (!active) return;
        setTagClassificationStatus(status);
        if (status.state === 'running') {
          wasRunning = true;
          if (!timer) timer = window.setInterval(() => { void refreshStatus(); }, 1_000);
        } else {
          window.clearInterval(timer);
          timer = 0;
          const changedAfterViewLoad = status.completedAt !== null
            && status.completedAt > lastViewLoadStartedAt.current;
          if (wasRunning || changedAfterViewLoad) {
            wasRunning = false;
            void onRefreshRef.current(sessionId);
          }
        }
      } catch {
        window.clearInterval(timer);
        timer = 0;
        if (active) setTagClassificationStatus(undefined);
      } finally {
        inFlight = false;
      }
    };

    void refreshStatus();
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [enabled, lastViewLoadStartedAt, sessionId, tagClassificationRefreshVersion]);

  useEffect(() => {
    setExtractionRunning(false);
    if (!enabled || !sessionId || historyExtractionActive) return;
    let active = true;
    let inFlight = false;
    let timer = 0;
    let wasRunning = false;
    const controller = new AbortController();

    const stopPolling = (): void => {
      window.clearInterval(timer);
      timer = 0;
    };
    const finish = (completedAt: number | null): void => {
      setExtractionRunning(false);
      const completedAfterViewLoad = shouldRefreshCompletedExtraction(completedAt, lastViewLoadStartedAt.current);
      if (!wasRunning && !completedAfterViewLoad) return;
      wasRunning = false;
      stopPolling();
      void onRefreshRef.current(sessionId);
    };
    const pollStatus = async (): Promise<void> => {
      if (!active || inFlight) return;
      inFlight = true;
      try {
        const status = await apiRequest<ImpressionsRunStatus>(
          `/api/impressions/${encodeURIComponent(sessionId)}/extraction-status`,
        );
        if (!active) return;
        setExtractionRunning(status.running);
        if (status.running) {
          wasRunning = true;
          if (!timer) timer = window.setInterval(() => { void pollStatus(); }, 1_000);
        } else {
          finish(status.completedAt);
        }
      } catch {
        stopPolling();
      } finally {
        inFlight = false;
      }
    };

    void watchImpressionsRunState(sessionId, controller.signal, (status) => {
      if (!active) return;
      setExtractionRunning(status.running);
      if (status.running) {
        wasRunning = true;
        if (!timer) timer = window.setInterval(() => { void pollStatus(); }, 1_000);
        void pollStatus();
      } else {
        finish(status.completedAt);
      }
    });

    return () => {
      active = false;
      controller.abort();
      stopPolling();
    };
  }, [enabled, historyExtractionActive, sessionId]);

  return { tagClassificationStatus, extractionRunning, retryTagClassification };
}
