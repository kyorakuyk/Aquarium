import type { DatabaseSync } from 'node:sqlite';

export interface QqGroupProfileCache {
  account: number;
  groupId: number;
  json: string;
  fetchedAt: number;
}

export interface QqMemberProfileCache {
  account: number;
  groupId: number;
  userId: number;
  json: string;
  fetchedAt: number;
}

export interface QqProfileRepository {
  getQqGroupProfile(account: number, groupId: number): QqGroupProfileCache | undefined;
  saveQqGroupProfile(profile: QqGroupProfileCache): void;
  getQqMemberProfile(account: number, groupId: number, userId: number): QqMemberProfileCache | undefined;
  listQqMemberProfiles(account: number, groupId: number): QqMemberProfileCache[];
  replaceQqMemberProfiles(account: number, groupId: number, profiles: readonly QqMemberProfileCache[]): void;
}

function validId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function assertCacheRecord(profile: QqGroupProfileCache | QqMemberProfileCache): void {
  if (!validId(profile.account) || !validId(profile.groupId)
    || !Number.isSafeInteger(profile.fetchedAt) || profile.fetchedAt < 0
    || typeof profile.json !== 'string') {
    throw new TypeError('QQ profile cache record is invalid');
  }
  if ('userId' in profile && !validId(profile.userId)) {
    throw new TypeError('QQ member profile userId is invalid');
  }
}

function numberValue(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'bigint' && value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)) {
    return Number(value);
  }
  throw new Error(`数据库字段 ${field} 不是安全整数`);
}

function stringValue(value: unknown, field: string): string {
  if (typeof value === 'string') return value;
  throw new Error(`数据库字段 ${field} 不是文本`);
}

function groupProfileRecord(row: Record<string, unknown>): QqGroupProfileCache {
  return {
    account: numberValue(row.account, 'account'),
    groupId: numberValue(row.group_id, 'group_id'),
    json: stringValue(row.json, 'json'),
    fetchedAt: numberValue(row.fetched_at, 'fetched_at'),
  };
}

function memberProfileRecord(row: Record<string, unknown>): QqMemberProfileCache {
  return {
    account: numberValue(row.account, 'account'),
    groupId: numberValue(row.group_id, 'group_id'),
    userId: numberValue(row.user_id, 'user_id'),
    json: stringValue(row.json, 'json'),
    fetchedAt: numberValue(row.fetched_at, 'fetched_at'),
  };
}

export function createQqProfileQueries(database: DatabaseSync): QqProfileRepository {
  const selectGroup = database.prepare(`
    SELECT account, group_id, json, fetched_at
    FROM qq_group_profiles
    WHERE account = ? AND group_id = ?
  `);
  const upsertGroup = database.prepare(`
    INSERT INTO qq_group_profiles (account, group_id, json, fetched_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(account, group_id) DO UPDATE SET
      json = excluded.json,
      fetched_at = excluded.fetched_at
  `);
  const selectMember = database.prepare(`
    SELECT account, group_id, user_id, json, fetched_at
    FROM qq_member_profiles
    WHERE account = ? AND group_id = ? AND user_id = ?
  `);
  const selectMembers = database.prepare(`
    SELECT account, group_id, user_id, json, fetched_at
    FROM qq_member_profiles
    WHERE account = ? AND group_id = ?
    ORDER BY user_id
  `);
  const deleteMembers = database.prepare('DELETE FROM qq_member_profiles WHERE account = ? AND group_id = ?');
  const insertMember = database.prepare(`
    INSERT INTO qq_member_profiles (account, group_id, user_id, json, fetched_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  return {
    getQqGroupProfile(account, groupId) {
      if (!validId(account) || !validId(groupId)) return undefined;
      const row = selectGroup.get(account, groupId) as Record<string, unknown> | undefined;
      return row ? groupProfileRecord(row) : undefined;
    },

    saveQqGroupProfile(profile) {
      assertCacheRecord(profile);
      upsertGroup.run(profile.account, profile.groupId, profile.json, profile.fetchedAt);
    },

    getQqMemberProfile(account, groupId, userId) {
      if (!validId(account) || !validId(groupId) || !validId(userId)) return undefined;
      const row = selectMember.get(account, groupId, userId) as Record<string, unknown> | undefined;
      return row ? memberProfileRecord(row) : undefined;
    },

    listQqMemberProfiles(account, groupId) {
      if (!validId(account) || !validId(groupId)) return [];
      const rows = selectMembers.all(account, groupId) as Array<Record<string, unknown>>;
      return rows.map(memberProfileRecord);
    },

    replaceQqMemberProfiles(account, groupId, profiles) {
      if (!validId(account) || !validId(groupId)) throw new TypeError('QQ member profile scope is invalid');
      for (const profile of profiles) {
        assertCacheRecord(profile);
        if (profile.account !== account || profile.groupId !== groupId) {
          throw new TypeError('QQ member profile scope does not match replacement scope');
        }
      }
      database.exec('BEGIN IMMEDIATE;');
      try {
        deleteMembers.run(account, groupId);
        for (const profile of profiles) {
          insertMember.run(profile.account, profile.groupId, profile.userId, profile.json, profile.fetchedAt);
        }
        database.exec('COMMIT;');
      } catch (error) {
        if (database.isTransaction) database.exec('ROLLBACK;');
        throw error;
      }
    },
  };
}
