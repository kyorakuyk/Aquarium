const TERMINAL_HISTORY_IMPORT_PHASES = new Set(['done', 'cancelled', 'expired', 'error']);

export function shouldRefreshCompletedExtraction(completedAt: number | null, viewLoadStartedAt: number): boolean {
  return completedAt !== null && completedAt >= viewLoadStartedAt;
}

export function shouldRefreshHistoryImport(phase: string, jobSessionId: string, selectedSessionId: string): boolean {
  return selectedSessionId.length > 0
    && jobSessionId === selectedSessionId
    && TERMINAL_HISTORY_IMPORT_PHASES.has(phase);
}
