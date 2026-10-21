const TERMINAL_HISTORY_IMPORT_PHASES = new Set(['done', 'cancelled', 'expired', 'error']);

export function shouldRefreshCompletedExtraction(completedAt: number | null, viewLoadStartedAt: number): boolean {
  return completedAt !== null && completedAt >= viewLoadStartedAt;
}

export function shouldRefreshHistoryImport(phase: string, jobSessionId: string, selectedSessionId: string): boolean {
  return selectedSessionId.length > 0
    && jobSessionId === selectedSessionId
    && TERMINAL_HISTORY_IMPORT_PHASES.has(phase);
}

export function tagClassificationStatusText(status: {
  state: string;
  processed: number;
  total: number;
} | undefined): string | undefined {
  if (status?.state === 'error') return '上次整理失败，可重试';
  if (status?.state === 'running') {
    return `正在整理旧标签：${status.processed.toLocaleString('zh-CN')} / ${status.total.toLocaleString('zh-CN')}。`;
  }
  return undefined;
}
