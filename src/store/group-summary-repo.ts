import type { DatabaseSync } from 'node:sqlite';

export interface GroupSummaryRecord {
  account: number;
  sessionId: string;
  text: string;
  manual: boolean;
  updatedAt: number;
}

export type GroupSummaryWrite = Pick<GroupSummaryRecord, 'account' | 'sessionId' | 'text' | 'updatedAt'>;

export interface GroupSummaryRepository {
  getGroupSummary(account: number, sessionId: string): GroupSummaryRecord | undefined;
  saveGeneratedGroupSummary(input: GroupSummaryWrite): boolean;
  saveManualGroupSummary(input: GroupSummaryWrite): void;
  saveImportedGroupSummary(input: GroupSummaryWrite & { manual: boolean }): void;
  deleteGroupSummary(account: number, sessionId: string): boolean;
}

function numberValue(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'bigint' && Number.isSafeInteger(Number(value))) return Number(value);
  throw new Error(`数据库字段 ${field} 不是安全整数`);
}

function parseGroupSummary(row: Record<string, unknown>): GroupSummaryRecord {
  const manual = numberValue(row.manual, 'manual');
  if (manual !== 0 && manual !== 1) throw new Error('数据库字段 manual 无效');
  return {
    account: numberValue(row.account, 'account'),
    sessionId: typeof row.session_id === 'string' ? row.session_id : '',
    text: typeof row.text === 'string' ? row.text : '',
    manual: manual === 1,
    updatedAt: numberValue(row.updated_at, 'updated_at'),
  };
}

function validate(input: GroupSummaryWrite): string {
  if (!Number.isSafeInteger(input.account) || input.account <= 0
    || typeof input.sessionId !== 'string' || !input.sessionId.startsWith(`${input.account}:group:`)
    || !Number.isSafeInteger(input.updatedAt) || input.updatedAt < 0) {
    throw new RangeError('群印象摘要主键或时间无效');
  }
  const text = input.text.trim();
  if (!text || Array.from(text).length > 50 || /[\r\n]/u.test(text)) {
    throw new RangeError('群印象摘要必须为 1 到 50 个 Unicode 字符的单行文本');
  }
  return text;
}

export function createGroupSummaryRepository(database: DatabaseSync): GroupSummaryRepository {
  const select = database.prepare(`
    SELECT account, session_id, text, manual, updated_at
    FROM group_summaries WHERE account = ? AND session_id = ?
  `);
  const saveGenerated = database.prepare(`
    INSERT INTO group_summaries (account, session_id, text, manual, updated_at)
    VALUES (?, ?, ?, 0, ?)
    ON CONFLICT(account, session_id) DO UPDATE SET
      text = excluded.text,
      updated_at = excluded.updated_at
    WHERE group_summaries.manual = 0
  `);
  const saveManual = database.prepare(`
    INSERT INTO group_summaries (account, session_id, text, manual, updated_at)
    VALUES (?, ?, ?, 1, ?)
    ON CONFLICT(account, session_id) DO UPDATE SET
      text = excluded.text,
      manual = 1,
      updated_at = excluded.updated_at
  `);
  const saveImported = database.prepare(`
    INSERT INTO group_summaries (account, session_id, text, manual, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(account, session_id) DO UPDATE SET
      text = excluded.text,
      manual = excluded.manual,
      updated_at = excluded.updated_at
  `);
  const deleteBySession = database.prepare('DELETE FROM group_summaries WHERE account = ? AND session_id = ?');

  return {
    getGroupSummary(account, sessionId) {
      if (!Number.isSafeInteger(account) || account <= 0
        || typeof sessionId !== 'string' || !sessionId.startsWith(`${account}:group:`)) return undefined;
      const row = select.get(account, sessionId) as Record<string, unknown> | undefined;
      return row ? parseGroupSummary(row) : undefined;
    },
    saveGeneratedGroupSummary(input) {
      const text = validate(input);
      return Number(saveGenerated.run(input.account, input.sessionId, text, input.updatedAt).changes) > 0;
    },
    saveManualGroupSummary(input) {
      const text = validate(input);
      saveManual.run(input.account, input.sessionId, text, input.updatedAt);
    },
    saveImportedGroupSummary(input) {
      const text = validate(input);
      saveImported.run(input.account, input.sessionId, text, input.manual ? 1 : 0, input.updatedAt);
    },
    deleteGroupSummary(account, sessionId) {
      if (!Number.isSafeInteger(account) || account <= 0
        || typeof sessionId !== 'string' || !sessionId.startsWith(`${account}:group:`)) return false;
      return Number(deleteBySession.run(account, sessionId).changes) > 0;
    },
  };
}
