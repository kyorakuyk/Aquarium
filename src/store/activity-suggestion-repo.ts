import type { DatabaseSync } from 'node:sqlite';

export interface ActivitySuggestionRepository {
  isDismissed(sessionId: string, windowKey: string, now: number): boolean;
  dismiss(sessionId: string, windowKey: string, at: number): void;
}

const DISMISSAL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function assertSuggestionKey(sessionId: string, windowKey: string): void {
  if (sessionId.length === 0 || windowKey.length === 0) throw new TypeError('活动建议标识不能为空');
}

export function createActivitySuggestionRepository(database: DatabaseSync): ActivitySuggestionRepository {
  const selectDismissal = database.prepare(`
    SELECT dismissed_at FROM activity_suggestion_dismissals
    WHERE session_id = ? AND window_key = ?
  `);
  const upsertDismissal = database.prepare(`
    INSERT INTO activity_suggestion_dismissals (session_id, window_key, dismissed_at)
    VALUES (?, ?, ?)
    ON CONFLICT(session_id, window_key) DO UPDATE SET dismissed_at = excluded.dismissed_at
  `);

  return {
    isDismissed(sessionId, windowKey, now) {
      assertSuggestionKey(sessionId, windowKey);
      if (!Number.isFinite(now)) throw new RangeError('活动建议查询时间无效');
      const row = selectDismissal.get(sessionId, windowKey) as { dismissed_at: number | bigint } | undefined;
      if (!row) return false;
      const dismissedAt = typeof row.dismissed_at === 'bigint' ? Number(row.dismissed_at) : row.dismissed_at;
      return dismissedAt <= now && dismissedAt > now - DISMISSAL_WINDOW_MS;
    },
    dismiss(sessionId, windowKey, at) {
      assertSuggestionKey(sessionId, windowKey);
      if (!Number.isSafeInteger(at)) throw new RangeError('活动建议关闭时间无效');
      upsertDismissal.run(sessionId, windowKey, at);
    },
  };
}
