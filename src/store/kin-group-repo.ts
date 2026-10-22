import type { DatabaseSync } from 'node:sqlite';

export interface KinGroupRecord {
  id: number;
  name: string;
  accounts: number[];
}

export interface KinTagPromptState {
  id: number;
  inPrompt: boolean;
}

export interface KinGroupRepository {
  createKinGroup(name: string): number;
  listKinGroups(): KinGroupRecord[];
  setKinGroupMembers(groupId: number, accounts: readonly number[]): boolean;
  deleteKinGroup(groupId: number): boolean;
  kinGroupAccounts(groupId: number): number[];
  kinGroupIdsForAccount(account: number): number[];
  sameKinGroup(firstAccount: number, secondAccount: number): boolean;
  kinTagPromptState(account: number, sessionId: string, tagId: number): KinTagPromptState;
  updateKinTagPromptStateById(id: number, inPrompt: boolean): void;
}

function numberValue(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  throw new Error(`数据库字段 ${field} 不是整数`);
}

function stringValue(value: unknown, field: string): string {
  if (typeof value === 'string') return value;
  throw new Error(`数据库字段 ${field} 不是文本`);
}

function validId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function validGroupName(value: string): string {
  const name = value.trim();
  const length = Array.from(name).length;
  if (length < 1 || length > 40) throw new RangeError('眷属组名称必须为 1–40 个字符');
  return name;
}

export function createKinGroupRepository(database: DatabaseSync): KinGroupRepository {
  const insertGroup = database.prepare('INSERT INTO kin_groups (name) VALUES (?)');
  const selectGroups = database.prepare('SELECT id, name FROM kin_groups ORDER BY id');
  const selectGroup = database.prepare('SELECT id FROM kin_groups WHERE id = ?');
  const deleteGroup = database.prepare('DELETE FROM kin_groups WHERE id = ?');
  const selectAccounts = database.prepare(
    'SELECT account FROM kin_group_members WHERE group_id = ? ORDER BY account',
  );
  const selectGroupIds = database.prepare(
    'SELECT group_id FROM kin_group_members WHERE account = ? ORDER BY group_id',
  );
  const selectSharedGroup = database.prepare(`
    SELECT 1 FROM kin_group_members AS first
    JOIN kin_group_members AS second ON second.group_id = first.group_id
    WHERE first.account = ? AND second.account = ? LIMIT 1
  `);
  const deleteMembers = database.prepare('DELETE FROM kin_group_members WHERE group_id = ?');
  const insertMember = database.prepare('INSERT INTO kin_group_members (group_id, account) VALUES (?, ?)');
  const ensureTagPromptState = database.prepare(`
    INSERT INTO kin_tag_states (account, session_id, tag_id)
    VALUES (?, ?, ?)
    ON CONFLICT (account, session_id, tag_id) DO NOTHING
  `);
  const selectTagPromptState = database.prepare(
    'SELECT id, in_prompt FROM kin_tag_states WHERE account = ? AND session_id = ? AND tag_id = ?',
  );
  const updateTagPromptState = database.prepare('UPDATE kin_tag_states SET in_prompt = ? WHERE id = ?');

  return {
    createKinGroup(name) {
      const result = insertGroup.run(validGroupName(name));
      return numberValue(result.lastInsertRowid, 'lastInsertRowid');
    },

    listKinGroups() {
      const rows = selectGroups.all() as Array<Record<string, unknown>>;
      return rows.map((row) => {
        const id = numberValue(row.id, 'id');
        const accounts = (selectAccounts.all(id) as Array<Record<string, unknown>>)
          .map((member) => numberValue(member.account, 'account'));
        return { id, name: stringValue(row.name, 'name'), accounts };
      });
    },

    setKinGroupMembers(groupId, accounts) {
      if (!validId(groupId) || accounts.some((account) => !validId(account))) {
        throw new RangeError('眷属组编号或账号无效');
      }
      if (!selectGroup.get(groupId)) return false;
      const uniqueAccounts = [...new Set(accounts)].sort((first, second) => first - second);
      database.exec('SAVEPOINT set_kin_group_members');
      try {
        deleteMembers.run(groupId);
        for (const account of uniqueAccounts) insertMember.run(groupId, account);
        database.exec('RELEASE SAVEPOINT set_kin_group_members');
        return true;
      } catch (error) {
        database.exec('ROLLBACK TO SAVEPOINT set_kin_group_members');
        database.exec('RELEASE SAVEPOINT set_kin_group_members');
        throw error;
      }
    },

    deleteKinGroup(groupId) {
      if (!validId(groupId)) return false;
      const result = deleteGroup.run(groupId);
      return result.changes === 1 || result.changes === 1n;
    },

    kinGroupAccounts(groupId) {
      if (!validId(groupId)) return [];
      return (selectAccounts.all(groupId) as Array<Record<string, unknown>>)
        .map((row) => numberValue(row.account, 'account'));
    },

    kinGroupIdsForAccount(account) {
      if (!validId(account)) return [];
      return (selectGroupIds.all(account) as Array<Record<string, unknown>>)
        .map((row) => numberValue(row.group_id, 'group_id'));
    },

    sameKinGroup(firstAccount, secondAccount) {
      if (!validId(firstAccount) || !validId(secondAccount)) return false;
      return selectSharedGroup.get(firstAccount, secondAccount) !== undefined;
    },

    kinTagPromptState(account, sessionId, tagId) {
      if (!validId(account) || !validId(tagId) || typeof sessionId !== 'string'
        || sessionId.length < 1 || sessionId.length > 512) {
        throw new RangeError('眷属知识迟滞状态查询参数无效');
      }
      ensureTagPromptState.run(account, sessionId, tagId);
      const row = selectTagPromptState.get(account, sessionId, tagId) as Record<string, unknown> | undefined;
      if (!row) throw new Error('眷属知识迟滞状态不存在');
      const inPrompt = numberValue(row.in_prompt, 'in_prompt');
      if (inPrompt !== 0 && inPrompt !== 1) throw new Error('数据库字段 in_prompt 无效');
      return { id: numberValue(row.id, 'id'), inPrompt: inPrompt === 1 };
    },

    updateKinTagPromptStateById(id, inPrompt) {
      if (!validId(id) || typeof inPrompt !== 'boolean') {
        throw new RangeError('眷属知识迟滞状态无效');
      }
      updateTagPromptState.run(inPrompt ? 1 : 0, id);
    },
  };
}
