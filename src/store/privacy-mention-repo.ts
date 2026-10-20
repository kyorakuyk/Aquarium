import type { DatabaseSync } from 'node:sqlite';
import {
  privateFactFromRow,
  type PrivateFactLevel,
  type PrivateFactMentionInput,
  type PrivateFactMentionResult,
  type PrivateFactRecord,
} from './privacy-repo.ts';

function validateInput(input: PrivateFactMentionInput): void {
  if (!Number.isSafeInteger(input.account) || input.account <= 0
    || !Number.isSafeInteger(input.ownerId) || input.ownerId <= 0
    || !Number.isSafeInteger(input.id) || input.id <= 0
    || typeof input.evidence.sessionId !== 'string'
    || !input.evidence.sessionId.startsWith(`${input.account}:group:`)
    || typeof input.evidence.messageId !== 'string' || input.evidence.messageId.length === 0
    || !Number.isFinite(input.evidence.time)
    || !Number.isFinite(input.dayStart) || !Number.isFinite(input.nextDayStart)
    || input.nextDayStart <= input.dayStart
    || input.evidence.time < input.dayStart || input.evidence.time >= input.nextDayStart
    || !Number.isFinite(input.updatedAt)
    || !Number.isSafeInteger(input.promoteMentions) || input.promoteMentions < 2) {
    throw new RangeError('私聊事实提及更新参数无效');
  }
}

function nextLevel(fact: PrivateFactRecord, mentions: number, promoteMentions: number): PrivateFactLevel {
  if (fact.levelSource === 'manual') return fact.level;
  return mentions >= promoteMentions ? 'L2' : 'L1';
}

export function createPrivateFactMentionQueries(database: DatabaseSync) {
  const selectActiveFact = database.prepare(`
    SELECT id, account, owner_id, session_id, text, keywords_json, level, level_source, mentions,
      mention_evidence_json, evidence_json, status, created_at, updated_at
    FROM private_facts
    WHERE id = ? AND account = ? AND owner_id = ? AND status = 'active'
  `);
  const updateMention = database.prepare(`
    UPDATE private_facts
    SET mentions = ?, mention_evidence_json = ?, level = ?, updated_at = ?
    WHERE id = ? AND account = ? AND owner_id = ? AND status = 'active'
  `);

  return {
    recordPrivateFactMention(input: PrivateFactMentionInput): PrivateFactMentionResult {
      validateInput(input);
      database.exec('BEGIN IMMEDIATE');
      let transactionOpen = true;
      try {
        const row = selectActiveFact.get(input.id, input.account, input.ownerId) as Record<string, unknown> | undefined;
        if (!row) {
          database.exec('COMMIT');
          transactionOpen = false;
          return { recorded: false };
        }
        const fact = privateFactFromRow(row);
        const alreadyCounted = fact.mentionEvidence.some((item) => item.messageId === input.evidence.messageId
          || (item.time >= input.dayStart && item.time < input.nextDayStart));
        if (alreadyCounted) {
          database.exec('COMMIT');
          transactionOpen = false;
          return { recorded: false, fact };
        }

        const mentions = fact.mentions + 1;
        if (!Number.isSafeInteger(mentions)) throw new RangeError('私聊事实提及次数超出范围');
        const mentionEvidence = [...fact.mentionEvidence, input.evidence].slice(-5);
        updateMention.run(
          mentions,
          JSON.stringify(mentionEvidence),
          nextLevel(fact, mentions, input.promoteMentions),
          input.updatedAt,
          input.id,
          input.account,
          input.ownerId,
        );
        const updatedRow = selectActiveFact.get(input.id, input.account, input.ownerId) as Record<string, unknown> | undefined;
        database.exec('COMMIT');
        transactionOpen = false;
        return updatedRow
          ? { recorded: true, fact: privateFactFromRow(updatedRow) }
          : { recorded: false };
      } catch (error) {
        if (transactionOpen) database.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
