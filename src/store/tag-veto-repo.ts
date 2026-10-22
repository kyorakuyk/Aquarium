import type { DatabaseSync } from 'node:sqlite';
import { isTagCategory, normalizeTagSubjectPath, type TagCategory, type TagKind } from '../core/impressions/tag-model.ts';
import type { TagRepositoryQueries } from './tag-repo.ts';
import { createTagSubjectRepository } from './tag-subject-repo.ts';

export interface TagVetoRecord {
  id: number;
  account: number;
  sessionId: string;
  userId: number | null;
  category: TagCategory;
  subjectNorm: string;
  textNorm: string;
  createdAt: number;
}

export interface TagVetoRepository {
  deleteTagAndCreateVeto(id: number, expected?: { account: number; kind: TagKind }): boolean;
  insertTagVeto(veto: Omit<TagVetoRecord, 'id'>): boolean;
  deleteTagVetoesForSession(account: number, sessionId: string): number;
  listTagVetoes(account: number, sessionId: string): TagVetoRecord[];
  isTagVetoed(input: {
    account: number;
    sessionId: string;
    userId: number | null;
    category: TagCategory;
    subject: string | null;
    textNorm: string;
  }): boolean;
  deleteTagVeto(id: number): boolean;
}

function numberValue(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  throw new Error(`数据库字段 ${field} 不是数字`);
}

function nullableNumber(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  return numberValue(value, field);
}

function stringValue(value: unknown, field: string): string {
  if (typeof value === 'string') return value;
  throw new Error(`数据库字段 ${field} 不是文本`);
}

export function createTagVetoQueries(
  database: DatabaseSync,
  tags: TagRepositoryQueries,
  now: () => number = Date.now,
): TagVetoRepository {
  const subjects = createTagSubjectRepository(database);
  const selectVetoExists = database.prepare(`
    SELECT 1 FROM tag_vetoes
    WHERE account = ? AND session_id = ? AND user_id IS ?
      AND category = ? AND subject_norm = ? AND text_norm = ?
    LIMIT 1
  `);
  const insertVetoIfMissing = database.prepare(`
    INSERT INTO tag_vetoes (account, session_id, user_id, category, subject_norm, text_norm, created_at)
    SELECT ?, ?, ?, ?, ?, ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM tag_vetoes
      WHERE account = ? AND session_id = ? AND user_id IS ?
        AND category = ? AND subject_norm = ? AND text_norm = ?
    )
  `);
  const selectVetoesForSession = database.prepare(`
    SELECT id, account, session_id, user_id, category, subject_norm, text_norm, created_at
    FROM tag_vetoes
    WHERE account = ? AND session_id = ?
    ORDER BY created_at DESC, id DESC
  `);
  const deleteVetoById = database.prepare('DELETE FROM tag_vetoes WHERE id = ?');
  const deleteVetoesForSession = database.prepare('DELETE FROM tag_vetoes WHERE account = ? AND session_id = ?');

  const subjectNorm = (account: number, category: TagCategory, subject: string | null): string => {
    if (subject === null) return '';
    const canonical = subjects.canonicalTagSubject(account, category, subject);
    return normalizeTagSubjectPath(canonical) ?? '';
  };

  return {
    deleteTagAndCreateVeto(id, expected) {
      if (!Number.isSafeInteger(id) || id <= 0) return false;
      database.exec('BEGIN IMMEDIATE');
      let transactionOpen = true;
      try {
        const tag = tags.tagById(id);
        if (!tag || (expected && (tag.account !== expected.account || tag.kind !== expected.kind))) {
          database.exec('ROLLBACK');
          transactionOpen = false;
          return false;
        }
        const normalizedSubject = subjectNorm(tag.account, tag.category, tag.subject);
        const normalizedText = tag.norm;
        insertVetoIfMissing.run(
          tag.account,
          tag.sessionId,
          tag.userId,
          tag.category,
          normalizedSubject,
          normalizedText,
          now(),
          tag.account,
          tag.sessionId,
          tag.userId,
          tag.category,
          normalizedSubject,
          normalizedText,
        );
        if (!tags.deleteTag(id, expected)) {
          database.exec('ROLLBACK');
          transactionOpen = false;
          return false;
        }
        database.exec('COMMIT');
        transactionOpen = false;
        return true;
      } catch (error) {
        if (transactionOpen) database.exec('ROLLBACK');
        throw error;
      }
    },

    listTagVetoes(account, sessionId) {
      const rows = selectVetoesForSession.all(account, sessionId) as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        id: numberValue(row.id, 'id'),
        account: numberValue(row.account, 'account'),
        sessionId: stringValue(row.session_id, 'session_id'),
        userId: nullableNumber(row.user_id, 'user_id'),
        category: stringValue(row.category, 'category') as TagCategory,
        subjectNorm: stringValue(row.subject_norm, 'subject_norm'),
        textNorm: stringValue(row.text_norm, 'text_norm'),
        createdAt: numberValue(row.created_at, 'created_at'),
      }));
    },

    insertTagVeto(veto) {
      const subjectNorm = veto.subjectNorm === '' ? '' : normalizeTagSubjectPath(veto.subjectNorm);
      const textNorm = veto.textNorm;
      if (!Number.isSafeInteger(veto.account) || veto.account <= 0
        || !Number.isSafeInteger(veto.createdAt) || veto.createdAt < 0
        || (veto.userId !== null && (!Number.isSafeInteger(veto.userId) || veto.userId <= 0))
        || !isTagCategory(veto.category)
        || !veto.sessionId.startsWith(`${veto.account}:group:`)
        || veto.subjectNorm.length > 120 || subjectNorm === null || subjectNorm === undefined
        || textNorm.length === 0 || textNorm.length > 120) {
        throw new RangeError('标签否决记录无效');
      }
      const result = insertVetoIfMissing.run(
        veto.account,
        veto.sessionId,
        veto.userId,
        veto.category,
        subjectNorm,
        textNorm,
        veto.createdAt,
        veto.account,
        veto.sessionId,
        veto.userId,
        veto.category,
        subjectNorm,
        textNorm,
      );
      return Number(result.changes) > 0;
    },

    deleteTagVetoesForSession(account, sessionId) {
      if (!Number.isSafeInteger(account) || account <= 0
        || typeof sessionId !== 'string' || !sessionId.startsWith(`${account}:group:`)) {
        throw new RangeError('标签否决会话无效');
      }
      return Number(deleteVetoesForSession.run(account, sessionId).changes);
    },

    isTagVetoed(input) {
      const normalizedSubject = subjectNorm(input.account, input.category, input.subject);
      return selectVetoExists.get(
        input.account,
        input.sessionId,
        input.userId,
        input.category,
        normalizedSubject,
        input.textNorm,
      ) !== undefined;
    },

    deleteTagVeto(id) {
      if (!Number.isSafeInteger(id) || id <= 0) return false;
      const result = deleteVetoById.run(id);
      return result.changes === 1 || result.changes === 1n;
    },
  };
}
