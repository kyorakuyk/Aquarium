import type { DatabaseSync } from 'node:sqlite';
import { normalizeTagSubjectPath, type TagCategory } from '../core/impressions/tag-model.ts';
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
  deleteTagAndCreateVeto(id: number): boolean;
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

  const subjectNorm = (account: number, category: TagCategory, subject: string | null): string => {
    if (subject === null) return '';
    const canonical = subjects.canonicalTagSubject(account, category, subject);
    return normalizeTagSubjectPath(canonical) ?? '';
  };

  return {
    deleteTagAndCreateVeto(id) {
      if (!Number.isSafeInteger(id) || id <= 0) return false;
      database.exec('BEGIN IMMEDIATE');
      let transactionOpen = true;
      try {
        const tag = tags.tagById(id);
        if (!tag) {
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
        if (!tags.deleteTag(id)) {
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
