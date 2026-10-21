import type { DatabaseSync } from 'node:sqlite';

export interface MemberSummaryRecord {
  account: number;
  userId: number;
  text: string;
  manual: boolean;
  updatedAt: number;
}

export type MemberSummaryWrite = Pick<MemberSummaryRecord, 'account' | 'userId' | 'text' | 'updatedAt'>;

export interface MemberSummaryRepository {
  get(account: number, userId: number): MemberSummaryRecord | undefined;
  saveGenerated(input: MemberSummaryWrite): boolean;
  saveManual(input: MemberSummaryWrite): void;
  saveImported(input: MemberSummaryWrite & { manual: boolean }): void;
}

function numberValue(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'bigint' && Number.isSafeInteger(Number(value))) return Number(value);
  throw new Error(`数据库字段 ${field} 不是安全整数`);
}

function textValue(value: unknown, field: string): string {
  if (typeof value === 'string') return value;
  throw new Error(`数据库字段 ${field} 不是文本`);
}

function parseSummary(row: Record<string, unknown>): MemberSummaryRecord {
  const manual = numberValue(row.manual, 'manual');
  if (manual !== 0 && manual !== 1) throw new Error('数据库字段 manual 无效');
  return {
    account: numberValue(row.account, 'account'),
    userId: numberValue(row.user_id, 'user_id'),
    text: textValue(row.text, 'text'),
    manual: manual === 1,
    updatedAt: numberValue(row.updated_at, 'updated_at'),
  };
}

function validateSummary(input: Omit<MemberSummaryRecord, 'manual'>): string {
  if (!Number.isSafeInteger(input.account) || input.account <= 0
    || !Number.isSafeInteger(input.userId) || input.userId <= 0
    || !Number.isSafeInteger(input.updatedAt) || input.updatedAt < 0) {
    throw new RangeError('成员印象摘要主键或时间无效');
  }
  const text = input.text.trim();
  if (!text || Array.from(text).length > 50 || /[\r\n]/u.test(text)) {
    throw new RangeError('成员印象摘要必须为 1 到 50 字的单行文本');
  }
  return text;
}

export function createMemberSummaryRepository(database: DatabaseSync): MemberSummaryRepository {
  const selectSummary = database.prepare(`
    SELECT account, user_id, text, manual, updated_at
    FROM member_summaries WHERE account = ? AND user_id = ?
  `);
  const saveGenerated = database.prepare(`
    INSERT INTO member_summaries (account, user_id, text, manual, updated_at)
    VALUES (?, ?, ?, 0, ?)
    ON CONFLICT(account, user_id) DO UPDATE SET
      text = excluded.text,
      updated_at = excluded.updated_at
    WHERE member_summaries.manual = 0
  `);
  const saveManual = database.prepare(`
    INSERT INTO member_summaries (account, user_id, text, manual, updated_at)
    VALUES (?, ?, ?, 1, ?)
    ON CONFLICT(account, user_id) DO UPDATE SET
      text = excluded.text,
      manual = 1,
      updated_at = excluded.updated_at
  `);
  const saveImported = database.prepare(`
    INSERT INTO member_summaries (account, user_id, text, manual, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(account, user_id) DO UPDATE SET
      text = excluded.text,
      manual = excluded.manual,
      updated_at = excluded.updated_at
  `);

  return {
    get(account: number, userId: number): MemberSummaryRecord | undefined {
      if (!Number.isSafeInteger(account) || account <= 0
        || !Number.isSafeInteger(userId) || userId <= 0) return undefined;
      const row = selectSummary.get(account, userId) as Record<string, unknown> | undefined;
      return row ? parseSummary(row) : undefined;
    },
    saveGenerated(input: MemberSummaryWrite): boolean {
      const text = validateSummary(input);
      const result = saveGenerated.run(input.account, input.userId, text, input.updatedAt);
      return Number(result.changes) > 0;
    },
    saveManual(input: MemberSummaryWrite): void {
      const text = validateSummary(input);
      saveManual.run(input.account, input.userId, text, input.updatedAt);
    },
    saveImported(input) {
      const text = validateSummary(input);
      saveImported.run(input.account, input.userId, text, input.manual ? 1 : 0, input.updatedAt);
    },
  };
}
