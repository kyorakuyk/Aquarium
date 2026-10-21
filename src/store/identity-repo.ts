import type { DatabaseSync } from 'node:sqlite';
import type { TagEvidence, StoredTag, TagRecord, TagRepositoryQueries } from './tag-repo.ts';
import type { TagVetoRepository } from './tag-veto-repo.ts';

export const ACCOUNT_KINDS = ['human', 'bot', 'alt', 'owner'] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export const RELATION_TYPES = ['alt', 'lover', 'brother', 'sister', 'roommate', 'enemy', 'other'] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

export interface AccountKindRecord {
  account: number;
  userId: number;
  kind: AccountKind;
  createdAt: number;
}

export interface StoredRelation {
  id: number;
  account: number;
  aUserId: number;
  bUserId: number;
  type: RelationType;
  label: string | null;
  locked: boolean;
  createdAt: number;
}

export interface RelationRecord extends Omit<StoredRelation, 'id'> {}

export interface IdentityRepository {
  getAccountKind(account: number, userId: number): AccountKindRecord | undefined;
  listAccountKinds(account: number): AccountKindRecord[];
  setAccountKind(account: number, userId: number, kind: AccountKind, createdAt: number): AccountKindRecord;
  deleteAccountKind(account: number, userId: number): boolean;
  createRelation(relation: RelationRecord): StoredRelation;
  listRelationsForUser(account: number, userId: number): StoredRelation[];
  updateRelationLock(account: number, relationId: number, locked: boolean): boolean;
  deleteRelation(account: number, relationId: number): boolean;
  mainUserIdFor(account: number, userId: number): number;
  linkAltAccount(input: {
    account: number;
    aUserId: number;
    bUserId: number;
    createdAt: number;
  }): StoredRelation;
}

function numberValue(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  throw new Error(`数据库字段 ${field} 不是数字`);
}

function stringValue(value: unknown, field: string): string {
  if (typeof value === 'string') return value;
  throw new Error(`数据库字段 ${field} 不是文本`);
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return stringValue(value, field);
}

function positiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${field} 必须是正整数`);
}

function timestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('时间必须是非负整数');
}

function accountKindRecord(row: Record<string, unknown>): AccountKindRecord {
  const kind = stringValue(row.kind, 'kind');
  if (!ACCOUNT_KINDS.includes(kind as AccountKind)) throw new Error('数据库字段 kind 无效');
  return {
    account: numberValue(row.account, 'account'),
    userId: numberValue(row.user_id, 'user_id'),
    kind: kind as AccountKind,
    createdAt: numberValue(row.created_at, 'created_at'),
  };
}

function relationRecord(row: Record<string, unknown>): StoredRelation {
  const type = stringValue(row.type, 'type');
  const locked = numberValue(row.locked, 'locked');
  if (!RELATION_TYPES.includes(type as RelationType) || (locked !== 0 && locked !== 1)) {
    throw new Error('数据库关系记录无效');
  }
  return {
    id: numberValue(row.id, 'id'),
    account: numberValue(row.account, 'account'),
    aUserId: numberValue(row.a_user_id, 'a_user_id'),
    bUserId: numberValue(row.b_user_id, 'b_user_id'),
    type: type as RelationType,
    label: nullableString(row.label, 'label'),
    locked: locked === 1,
    createdAt: numberValue(row.created_at, 'created_at'),
  };
}

function sameTag(left: StoredTag, right: StoredTag): boolean {
  return left.category === right.category
    && left.norm === right.norm
    && left.subject === right.subject
    && left.polarity === right.polarity;
}

function mergeEvidence(target: TagEvidence[], source: TagEvidence[]): TagEvidence[] {
  const messages = new Map<string, Extract<TagEvidence, { messageId: string }>>();
  const signatures = new Map<string, Extract<TagEvidence, { kind: 'signature' }>>();
  for (const evidence of [...target, ...source]) {
    if (evidence.kind === 'signature') {
      const previous = signatures.get(evidence.text);
      if (!previous || evidence.fetchedAt >= previous.fetchedAt) signatures.set(evidence.text, evidence);
    } else {
      const previous = messages.get(evidence.messageId);
      if (!previous || evidence.time >= previous.time) messages.set(evidence.messageId, evidence);
    }
  }
  const union: TagEvidence[] = [...messages.values(), ...signatures.values()];
  const timeOf = (evidence: TagEvidence) => evidence.kind === 'signature' ? evidence.fetchedAt : evidence.time;
  const keyOf = (evidence: TagEvidence) => evidence.kind === 'signature'
    ? `signature:${evidence.text}`
    : `message:${evidence.messageId}`;
  return union.sort((left, right) => timeOf(left) - timeOf(right) || keyOf(left).localeCompare(keyOf(right)));
}

function mergedSamples(target: StoredTag, source: StoredTag): number {
  const targetIds = new Set(target.evidence.flatMap((item) => item.kind === 'signature' ? [] : [item.messageId]));
  const duplicateIds = new Set(source.evidence.flatMap((item) => (
    item.kind === 'signature' || !targetIds.has(item.messageId) ? [] : [item.messageId]
  )));
  const samples = target.samples + Math.max(0, source.samples - duplicateIds.size);
  if (!Number.isSafeInteger(samples)) throw new RangeError('标签样本数超出安全整数范围');
  return samples;
}

export function createIdentityQueries(
  database: DatabaseSync,
  tags: TagRepositoryQueries,
  vetoes: TagVetoRepository,
): IdentityRepository {
  const selectKind = database.prepare('SELECT account, user_id, kind, created_at FROM account_kinds WHERE account = ? AND user_id = ?');
  const selectKinds = database.prepare('SELECT account, user_id, kind, created_at FROM account_kinds WHERE account = ? ORDER BY user_id');
  const upsertKind = database.prepare(`
    INSERT INTO account_kinds (account, user_id, kind, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(account, user_id) DO UPDATE SET kind = excluded.kind, created_at = excluded.created_at
  `);
  const deleteKind = database.prepare('DELETE FROM account_kinds WHERE account = ? AND user_id = ?');
  const insertRelation = database.prepare(`
    INSERT INTO relations (account, a_user_id, b_user_id, type, label, locked, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const selectRelation = database.prepare(`
    SELECT id, account, a_user_id, b_user_id, type, label, locked, created_at FROM relations WHERE account = ? AND id = ?
  `);
  const selectRelationsForUser = database.prepare(`
    SELECT id, account, a_user_id, b_user_id, type, label, locked, created_at
    FROM relations WHERE account = ? AND (a_user_id = ? OR b_user_id = ?) ORDER BY id
  `);
  const updateRelationLock = database.prepare('UPDATE relations SET locked = ? WHERE account = ? AND id = ?');
  const removeRelation = database.prepare('DELETE FROM relations WHERE account = ? AND id = ?');
  const selectAltMain = database.prepare("SELECT a_user_id FROM relations WHERE account = ? AND b_user_id = ? AND type = 'alt'");

  function readKind(account: number, userId: number): AccountKindRecord | undefined {
    const row = selectKind.get(account, userId) as Record<string, unknown> | undefined;
    return row ? accountKindRecord(row) : undefined;
  }

  function readRelation(account: number, id: number): StoredRelation | undefined {
    const row = selectRelation.get(account, id) as Record<string, unknown> | undefined;
    return row ? relationRecord(row) : undefined;
  }

  function resolveMainUserId(account: number, userId: number): number {
    positiveInteger(account, 'account');
    positiveInteger(userId, 'userId');
    const row = selectAltMain.get(account, userId) as { a_user_id: number | bigint } | undefined;
    return row ? numberValue(row.a_user_id, 'a_user_id') : userId;
  }

  function writeKind(account: number, userId: number, kind: AccountKind, createdAt: number): AccountKindRecord {
    positiveInteger(account, 'account');
    positiveInteger(userId, 'userId');
    timestamp(createdAt);
    if (!ACCOUNT_KINDS.includes(kind)) throw new RangeError('账号类型无效');
    upsertKind.run(account, userId, kind, createdAt);
    return readKind(account, userId)!;
  }

  function writeRelation(relation: RelationRecord): StoredRelation {
    positiveInteger(relation.account, 'account');
    positiveInteger(relation.aUserId, 'aUserId');
    positiveInteger(relation.bUserId, 'bUserId');
    timestamp(relation.createdAt);
    if (relation.aUserId === relation.bUserId || !RELATION_TYPES.includes(relation.type)) {
      throw new RangeError('关系对象无效');
    }
    if (relation.type === 'other') {
      if (!relation.label?.trim() || Array.from(relation.label).length > 40) throw new RangeError('其他关系需要有效名称');
    } else if (relation.label !== null) {
      throw new RangeError('只有其他关系可以填写名称');
    }
    const [aUserId, bUserId] = relation.type === 'alt'
      ? [relation.aUserId, relation.bUserId]
      : [Math.min(relation.aUserId, relation.bUserId), Math.max(relation.aUserId, relation.bUserId)];
    const result = insertRelation.run(
      relation.account,
      aUserId,
      bUserId,
      relation.type,
      relation.label,
      relation.locked ? 1 : 0,
      relation.createdAt,
    );
    return readRelation(relation.account, Number(result.lastInsertRowid))!;
  }

  function mergeAliasTags(account: number, mainUserId: number, altUserId: number, at: number): void {
    const sources = tags.listGroupTagsForUser(account, altUserId)
      .filter((tag) => tag.status === 'candidate' || tag.status === 'confirmed');
    for (const source of sources) {
      const targetTags = tags.listTagsForSubject(account, source.sessionId, mainUserId);
      const target = targetTags.find((tag) => sameTag(tag, source)
        && tag.status !== 'rejected' && tag.status !== 'superseded');
      const matchingRejected = targetTags.find((tag) => sameTag(tag, source) && tag.status === 'rejected');
      const vetoed = vetoes.isTagVetoed({
        account,
        sessionId: source.sessionId,
        userId: mainUserId,
        category: source.category,
        subject: source.subject,
        textNorm: source.norm,
      });
      let mainTagId = target?.id ?? matchingRejected?.id ?? null;
      if (target) {
        const preserveManual = target.source === 'manual' || source.source === 'manual'
          || target.origin === 'manual' || source.origin === 'manual';
        tags.updateTag(target.id, {
          samples: mergedSamples(target, source),
          evidence: mergeEvidence(target.evidence, source.evidence),
          locked: target.locked || source.locked,
          lastSeen: Math.max(target.lastSeen, source.lastSeen),
          status: target.status === 'confirmed' || source.status === 'confirmed' ? 'confirmed' : target.status,
          ...(preserveManual ? { source: 'manual', origin: 'manual' } : {}),
          updatedAt: at,
        });
      } else if (!matchingRejected && !vetoed) {
        const { id: _id, ...record } = source;
        mainTagId = tags.insertTag({ ...record, userId: mainUserId, updatedAt: at } satisfies TagRecord);
      }
      tags.updateTag(source.id, { status: 'superseded', supersededBy: mainTagId, updatedAt: at });
    }
  }

  return {
    getAccountKind: readKind,
    listAccountKinds(account) {
      positiveInteger(account, 'account');
      return (selectKinds.all(account) as Array<Record<string, unknown>>).map(accountKindRecord);
    },
    setAccountKind: writeKind,
    deleteAccountKind(account, userId) {
      positiveInteger(account, 'account');
      positiveInteger(userId, 'userId');
      return deleteKind.run(account, userId).changes > 0;
    },
    createRelation: writeRelation,
    listRelationsForUser(account, userId) {
      positiveInteger(account, 'account');
      positiveInteger(userId, 'userId');
      return (selectRelationsForUser.all(account, userId, userId) as Array<Record<string, unknown>>).map(relationRecord);
    },
    updateRelationLock(account, relationId, locked) {
      positiveInteger(account, 'account');
      positiveInteger(relationId, 'relationId');
      return updateRelationLock.run(locked ? 1 : 0, account, relationId).changes > 0;
    },
    deleteRelation(account, relationId) {
      positiveInteger(account, 'account');
      positiveInteger(relationId, 'relationId');
      return removeRelation.run(account, relationId).changes > 0;
    },
    mainUserIdFor: resolveMainUserId,
    linkAltAccount(input) {
      positiveInteger(input.account, 'account');
      positiveInteger(input.aUserId, 'aUserId');
      positiveInteger(input.bUserId, 'bUserId');
      timestamp(input.createdAt);
      if (input.aUserId === input.bUserId) throw new RangeError('主号和小号不能相同');
      database.exec('BEGIN IMMEDIATE');
      let transactionOpen = true;
      try {
        if (resolveMainUserId(input.account, input.aUserId) !== input.aUserId
          || resolveMainUserId(input.account, input.bUserId) !== input.bUserId) {
          throw new Error('小号关系不允许嵌套或重复链接');
        }
        const relation = writeRelation({
          account: input.account,
          aUserId: input.aUserId,
          bUserId: input.bUserId,
          type: 'alt',
          label: null,
          locked: false,
          createdAt: input.createdAt,
        });
        const existingKind = readKind(input.account, input.bUserId)?.kind;
        if (existingKind === undefined || existingKind === 'human') {
          writeKind(input.account, input.bUserId, 'alt', input.createdAt);
        }
        mergeAliasTags(input.account, input.aUserId, input.bUserId, input.createdAt);
        database.exec('COMMIT');
        transactionOpen = false;
        return relation;
      } catch (error) {
        if (transactionOpen) database.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
