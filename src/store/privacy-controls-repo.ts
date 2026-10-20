import type { DatabaseSync } from 'node:sqlite';
import {
  privateFactFromRow,
  type PrivateFactControlsInput,
  type PrivateFactLevel,
  type PrivateFactRecord,
} from './privacy-repo.ts';

function validateInput(input: PrivateFactControlsInput): void {
  if (!Number.isSafeInteger(input.account) || input.account <= 0
    || !Number.isSafeInteger(input.ownerId) || input.ownerId <= 0
    || !Number.isSafeInteger(input.id) || input.id <= 0
    || !Number.isSafeInteger(input.promoteMentions) || input.promoteMentions < 2
    || !Number.isFinite(input.updatedAt)) {
    throw new RangeError('私聊事实控制台更新参数无效');
  }
  if (input.text !== undefined) {
    const length = typeof input.text === 'string' ? Array.from(input.text).length : 0;
    if (length < 4 || length > 40) throw new RangeError('私聊事实 text 必须为 4–40 字');
  }
  if (input.level !== undefined && !['L0', 'L1', 'L2'].includes(input.level)) {
    throw new RangeError('私聊事实等级无效');
  }
  if (input.auto !== undefined && typeof input.auto !== 'boolean') {
    throw new RangeError('私聊事实 auto 参数无效');
  }
  if (input.auto === true && input.level !== undefined) {
    throw new RangeError('恢复自动等级时不能同时设置手动等级');
  }
  if (input.text === undefined && input.level === undefined && input.auto !== true) {
    throw new RangeError('私聊事实更新不能为空');
  }
}

function automaticLevel(mentions: number, promoteMentions: number): PrivateFactLevel {
  if (mentions === 0) return 'L0';
  return mentions >= promoteMentions ? 'L2' : 'L1';
}

export function createPrivateFactControlsQueries(database: DatabaseSync) {
  const selectActiveFact = database.prepare(`
    SELECT id, account, owner_id, session_id, text, keywords_json, level, level_source, mentions,
      mention_evidence_json, evidence_json, status, created_at, updated_at
    FROM private_facts
    WHERE id = ? AND account = ? AND owner_id = ? AND status = 'active'
  `);
  const updateFact = database.prepare(`
    UPDATE private_facts
    SET text = ?, level = ?, level_source = ?, updated_at = ?
    WHERE id = ? AND account = ? AND owner_id = ? AND status = 'active'
  `);

  return {
    updatePrivateFactControls(input: PrivateFactControlsInput): PrivateFactRecord | undefined {
      validateInput(input);
      database.exec('BEGIN IMMEDIATE');
      let transactionOpen = true;
      try {
        const row = selectActiveFact.get(input.id, input.account, input.ownerId) as Record<string, unknown> | undefined;
        if (!row) {
          database.exec('COMMIT');
          transactionOpen = false;
          return undefined;
        }
        const current = privateFactFromRow(row);
        let level = current.level;
        let levelSource = current.levelSource;
        if (input.auto === true) {
          level = automaticLevel(current.mentions, input.promoteMentions);
          levelSource = 'auto';
        } else if (input.level !== undefined) {
          level = input.level;
          levelSource = 'manual';
        }
        updateFact.run(
          input.text ?? current.text,
          level,
          levelSource,
          input.updatedAt,
          input.id,
          input.account,
          input.ownerId,
        );
        const updatedRow = selectActiveFact.get(input.id, input.account, input.ownerId) as Record<string, unknown> | undefined;
        if (!updatedRow) throw new Error('私聊事实更新后无法读取');
        const updated = privateFactFromRow(updatedRow);
        database.exec('COMMIT');
        transactionOpen = false;
        return updated;
      } catch (error) {
        if (transactionOpen) database.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
