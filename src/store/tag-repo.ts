import type { DatabaseSync } from 'node:sqlite';
import {
  isTagCategory,
  isTagOrigin,
  isTagPolarity,
  type TagCategory,
  type TagOrigin,
  type TagPolarity,
} from './tag-profile.ts';
import { createTagSubjectRepository } from './tag-subject-repo.ts';

export type TagStatus = 'candidate' | 'confirmed' | 'rejected' | 'superseded';
export type TagSource = 'auto' | 'manual';

export interface TagEvidence {
  messageId: string;
  time: number;
  quote: string;
}

export interface TagRecord {
  account: number;
  sessionId: string;
  userId: number | null;
  text: string;
  norm: string;
  category: TagCategory;
  subject: string | null;
  polarity: TagPolarity;
  origin: TagOrigin;
  locked: boolean;
  status: TagStatus;
  source: TagSource;
  samples: number;
  evidence: TagEvidence[];
  firstSeen: number;
  lastSeen: number;
  supersededBy: number | null;
  updatedAt: number;
}

export interface StoredTag extends TagRecord {
  id: number;
}

export interface TagUpdate {
  text?: string;
  norm?: string;
  category?: TagCategory;
  subject?: string | null;
  polarity?: TagPolarity;
  origin?: TagOrigin;
  source?: TagSource;
  locked?: boolean;
  status?: TagStatus;
  samples?: number;
  evidence?: TagEvidence[];
  lastSeen?: number;
  supersededBy?: number | null;
  updatedAt?: number;
}

export interface TagRunRecord {
  account: number;
  sessionId: string;
  lastRunAt: number | null;
  lastMessageTime: number | null;
}

export interface TagRepositoryQueries {
  insertTag(tag: TagRecord): number;
  tagById(id: number): StoredTag | undefined;
  listTagsForSubject(account: number, sessionId: string, userId: number | null): StoredTag[];
  listTagsForSession(account: number, sessionId: string): StoredTag[];
  listGroupTagsForUser(account: number, userId: number): StoredTag[];
  listUnlockedMiscTags(): StoredTag[];
  countLockedMiscTags(): number;
  senderNameFor(sessionId: string, senderId: number): string | undefined;
  updateTag(id: number, update: TagUpdate): void;
  getTagRun(account: number, sessionId: string): TagRunRecord | undefined;
  saveTagRun(run: TagRunRecord): void;
  countMessagesAfter(sessionId: string, time: number): number;
}

const TAG_COLUMNS = [
  'id', 'account', 'session_id', 'user_id', 'text', 'norm', 'category', 'subject', 'polarity', 'origin', 'locked',
  'status', 'source', 'samples', 'evidence_json', 'first_seen', 'last_seen', 'superseded_by', 'updated_at',
].join(', ');

function numberValue(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  throw new Error(`数据库字段 ${field} 不是数字`);
}

function stringValue(value: unknown, field: string): string {
  if (typeof value === 'string') return value;
  throw new Error(`数据库字段 ${field} 不是文本`);
}

function nullableNumber(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  return numberValue(value, field);
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return stringValue(value, field);
}

function tagRecord(row: Record<string, unknown>): StoredTag {
  const category = stringValue(row.category, 'category');
  const origin = stringValue(row.origin, 'origin');
  const polarityValue = nullableString(row.polarity, 'polarity');
  const lockedValue = numberValue(row.locked, 'locked');
  if (!isTagCategory(category)) throw new Error('数据库字段 category 无效');
  if (!isTagOrigin(origin)) throw new Error('数据库字段 origin 无效');
  if (polarityValue !== null && !isTagPolarity(polarityValue)) throw new Error('数据库字段 polarity 无效');
  if (lockedValue !== 0 && lockedValue !== 1) throw new Error('数据库字段 locked 无效');
  return {
    id: numberValue(row.id, 'id'),
    account: numberValue(row.account, 'account'),
    sessionId: stringValue(row.session_id, 'session_id'),
    userId: nullableNumber(row.user_id, 'user_id'),
    text: stringValue(row.text, 'text'),
    norm: stringValue(row.norm, 'norm'),
    category,
    subject: nullableString(row.subject, 'subject'),
    polarity: polarityValue,
    origin,
    locked: lockedValue === 1,
    status: stringValue(row.status, 'status') as TagStatus,
    source: stringValue(row.source, 'source') as TagSource,
    samples: numberValue(row.samples, 'samples'),
    evidence: JSON.parse(stringValue(row.evidence_json, 'evidence_json')) as TagEvidence[],
    firstSeen: numberValue(row.first_seen, 'first_seen'),
    lastSeen: numberValue(row.last_seen, 'last_seen'),
    supersededBy: nullableNumber(row.superseded_by, 'superseded_by'),
    updatedAt: numberValue(row.updated_at, 'updated_at'),
  };
}

const tagUpdateColumns: Record<keyof TagUpdate, string> = {
  text: 'text',
  norm: 'norm',
  category: 'category',
  subject: 'subject',
  polarity: 'polarity',
  origin: 'origin',
  source: 'source',
  locked: 'locked',
  status: 'status',
  samples: 'samples',
  evidence: 'evidence_json',
  lastSeen: 'last_seen',
  supersededBy: 'superseded_by',
  updatedAt: 'updated_at',
};

export function createTagQueries(database: DatabaseSync): TagRepositoryQueries {
  const subjects = createTagSubjectRepository(database);
  const insertTag = database.prepare(`
    INSERT INTO tags
      (account, session_id, user_id, text, norm, category, subject, polarity, origin, locked,
       status, source, samples, evidence_json, first_seen, last_seen, superseded_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectTagById = database.prepare(`SELECT ${TAG_COLUMNS} FROM tags WHERE id = ?`);
  const selectTagsForSubject = database.prepare(`
    SELECT ${TAG_COLUMNS}
    FROM tags
    WHERE account = ? AND session_id = ? AND user_id IS ?
    ORDER BY last_seen DESC, id DESC
  `);
  const selectTagsForSession = database.prepare(`
    SELECT ${TAG_COLUMNS}
    FROM tags
    WHERE account = ? AND session_id = ?
    ORDER BY last_seen DESC, id DESC
  `);
  const selectGroupTagsForUser = database.prepare(`
    SELECT ${TAG_COLUMNS}
    FROM tags
    WHERE account = ? AND user_id = ? AND session_id LIKE ?
    ORDER BY last_seen DESC, id DESC
  `);
  const selectUnlockedMiscTags = database.prepare(`
    SELECT ${TAG_COLUMNS}
    FROM tags
    WHERE category = 'misc' AND locked = 0 AND status != 'superseded'
    ORDER BY account, session_id, user_id, id
  `);
  const selectLockedMiscTagCount = database.prepare(`
    SELECT COUNT(*) AS total
    FROM tags
    WHERE category = 'misc' AND locked = 1 AND status != 'superseded'
  `);
  const selectSenderName = database.prepare(`
    SELECT sender_name
    FROM messages
    WHERE session_id = ? AND sender_id = ?
    ORDER BY time DESC, id DESC
    LIMIT 1
  `);
  const selectTagRun = database.prepare(`
    SELECT account, session_id, last_run_at, last_message_time
    FROM tag_runs
    WHERE account = ? AND session_id = ?
  `);
  const upsertTagRun = database.prepare(`
    INSERT INTO tag_runs (account, session_id, last_run_at, last_message_time)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(account, session_id) DO UPDATE SET
      last_run_at = excluded.last_run_at,
      last_message_time = excluded.last_message_time
  `);
  const selectMessageCountAfter = database.prepare(`
    SELECT COUNT(*) AS total
    FROM messages
    WHERE session_id = ? AND time > ?
  `);

  return {
    insertTag(tag) {
      const subject = tag.subject === null
        ? null
        : subjects.canonicalTagSubject(tag.account, tag.category, tag.subject);
      const result = insertTag.run(
        tag.account,
        tag.sessionId,
        tag.userId,
        tag.text,
        tag.norm,
        tag.category,
        subject,
        tag.polarity,
        tag.origin,
        tag.locked ? 1 : 0,
        tag.status,
        tag.source,
        tag.samples,
        JSON.stringify(tag.evidence),
        tag.firstSeen,
        tag.lastSeen,
        tag.supersededBy,
        tag.updatedAt,
      );
      return numberValue(result.lastInsertRowid, 'lastInsertRowid');
    },

    tagById(id) {
      if (!Number.isSafeInteger(id) || id <= 0) return undefined;
      const row = selectTagById.get(id) as Record<string, unknown> | undefined;
      return row ? tagRecord(row) : undefined;
    },

    listTagsForSubject(account, sessionId, userId) {
      const rows = selectTagsForSubject.all(account, sessionId, userId) as Array<Record<string, unknown>>;
      return rows.map(tagRecord);
    },

    listTagsForSession(account, sessionId) {
      const rows = selectTagsForSession.all(account, sessionId) as Array<Record<string, unknown>>;
      return rows.map(tagRecord);
    },

    listGroupTagsForUser(account, userId) {
      const rows = selectGroupTagsForUser.all(account, userId, `${account}:group:%`) as Array<Record<string, unknown>>;
      return rows.map(tagRecord);
    },

    listUnlockedMiscTags() {
      const rows = selectUnlockedMiscTags.all() as Array<Record<string, unknown>>;
      return rows.map(tagRecord);
    },

    countLockedMiscTags() {
      const row = selectLockedMiscTagCount.get() as Record<string, unknown> | undefined;
      return numberValue(row?.total ?? 0, 'total');
    },

    senderNameFor(sessionId, senderId) {
      const row = selectSenderName.get(sessionId, senderId) as Record<string, unknown> | undefined;
      return row ? stringValue(row.sender_name, 'sender_name') : undefined;
    },

    updateTag(id, update) {
      if (!Number.isSafeInteger(id) || id <= 0) return;
      const entries = (Object.entries(update) as Array<[keyof TagUpdate, TagUpdate[keyof TagUpdate]]>)
        .filter(([, value]) => value !== undefined);
      if (entries.length === 0) return;
      const row = selectTagById.get(id) as Record<string, unknown> | undefined;
      if (!row) return;
      const categoryValue = update.category ?? stringValue(row.category, 'category');
      if (!isTagCategory(categoryValue)) throw new Error('数据库字段 category 无效');
      const category = categoryValue;
      const account = numberValue(row.account, 'account');
      const assignments = entries.map(([field]) => `${tagUpdateColumns[field]} = ?`);
      const values = entries.map(([field, value]) => {
        if (field === 'evidence') return JSON.stringify(value);
        if (field === 'locked') return value ? 1 : 0;
        if (field === 'subject' && typeof value === 'string') {
          return subjects.canonicalTagSubject(account, category, value);
        }
        return value;
      });
      database.prepare(`UPDATE tags SET ${assignments.join(', ')} WHERE id = ?`)
        .run(...values as Array<string | number | null>, id);
    },

    getTagRun(account, sessionId) {
      const row = selectTagRun.get(account, sessionId) as Record<string, unknown> | undefined;
      if (!row) return undefined;
      return {
        account: numberValue(row.account, 'account'),
        sessionId: stringValue(row.session_id, 'session_id'),
        lastRunAt: nullableNumber(row.last_run_at, 'last_run_at'),
        lastMessageTime: nullableNumber(row.last_message_time, 'last_message_time'),
      };
    },

    saveTagRun(run) {
      upsertTagRun.run(run.account, run.sessionId, run.lastRunAt, run.lastMessageTime);
    },

    countMessagesAfter(sessionId, time) {
      if (!Number.isFinite(time)) throw new RangeError('查询时间必须是有限数字');
      const row = selectMessageCountAfter.get(sessionId, time) as Record<string, unknown> | undefined;
      return numberValue(row?.total ?? 0, 'total');
    },
  };
}
