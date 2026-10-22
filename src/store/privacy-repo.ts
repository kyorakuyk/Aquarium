import type { DatabaseSync } from 'node:sqlite';

export type PrivateFactLevel = 'L0' | 'L1' | 'L2';
export type PrivateFactLevelSource = 'auto' | 'manual';
export type PrivateFactStatus = 'active' | 'deleted';

export interface PrivateFactEvidence {
  messageId: string;
  time: number;
  quote: string;
}

export interface PrivateFactMentionEvidence {
  sessionId: string;
  messageId: string;
  time: number;
}

export interface PrivateFactRecord {
  id: number;
  account: number;
  ownerId: number;
  sessionId: string;
  text: string;
  keywords: string[];
  level: PrivateFactLevel;
  levelSource: PrivateFactLevelSource;
  mentions: number;
  mentionEvidence: PrivateFactMentionEvidence[];
  evidence: PrivateFactEvidence[];
  status: PrivateFactStatus;
  createdAt: number;
  updatedAt: number;
}

export type NewPrivateFactRecord = Omit<PrivateFactRecord, 'id'>;

export interface PrivateFactUpdate {
  text: string;
  keywords: string[];
  evidence: PrivateFactEvidence[];
  updatedAt: number;
}

export interface PrivacyRunRecord {
  account: number;
  sessionId: string;
  lastRunAt: number | null;
  lastMessageTime: number | null;
}

export interface PrivateFactMentionInput {
  account: number;
  ownerId: number;
  id: number;
  evidence: PrivateFactMentionEvidence;
  dayStart: number;
  nextDayStart: number;
  updatedAt: number;
  promoteMentions: number;
}

export interface PrivateFactMentionResult {
  recorded: boolean;
  fact?: PrivateFactRecord;
}

export interface PrivateFactMentionRepository {
  recordPrivateFactMention(input: PrivateFactMentionInput): PrivateFactMentionResult;
}

export interface PrivateFactControlsInput {
  account: number;
  ownerId: number;
  id: number;
  text?: string;
  level?: PrivateFactLevel;
  auto?: boolean;
  promoteMentions: number;
  updatedAt: number;
}

export interface PrivateFactControlsRepository {
  updatePrivateFactControls(input: PrivateFactControlsInput): PrivateFactRecord | undefined;
}

export interface PrivacyRepository {
  listPrivateFactsForOwner(account: number, ownerId: number, status?: PrivateFactStatus): PrivateFactRecord[];
  listPrivateFactsForAccount(account: number, status?: PrivateFactStatus): PrivateFactRecord[];
  listPrivateFactsForGroup(account: number, groupSessionId: string): PrivateFactRecord[];
  countPrivateOwnerMessagesAfter(sessionId: string, ownerId: number, afterTime: number): number;
  privateFactById(id: number): PrivateFactRecord | undefined;
  insertPrivateFact(fact: NewPrivateFactRecord): number;
  updatePrivateFact(id: number, update: PrivateFactUpdate): void;
  markPrivateFactDeleted(id: number, updatedAt: number): void;
  getPrivacyRun(account: number, sessionId: string): PrivacyRunRecord | undefined;
  savePrivacyRun(run: PrivacyRunRecord): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function textLength(value: string): number {
  return Array.from(value).length;
}

function validateIdentity(account: number, ownerId: number): void {
  if (!Number.isSafeInteger(account) || account <= 0 || !Number.isSafeInteger(ownerId) || ownerId <= 0) {
    throw new RangeError('私聊事实账号或主人编号无效');
  }
}

function validateSessionId(sessionId: string): void {
  if (typeof sessionId !== 'string' || sessionId.length === 0) throw new RangeError('私聊会话编号无效');
}

function validateText(value: string): void {
  const length = textLength(value);
  if (length < 4 || length > 40) throw new RangeError('私聊事实 text 必须为 4–40 字');
}

function validateKeywords(keywords: string[]): void {
  if (!Array.isArray(keywords) || keywords.length < 2 || keywords.length > 5
    || keywords.some((keyword) => textLength(keyword) < 2 || textLength(keyword) > 8)) {
    throw new RangeError('私聊事实关键词必须为 2–5 个且每个 2–8 字');
  }
}

function validateEvidence(evidence: PrivateFactEvidence[]): void {
  if (!Array.isArray(evidence) || evidence.length > 5
    || evidence.some((item) => !isRecord(item)
      || typeof item.messageId !== 'string' || item.messageId.length === 0
      || !Number.isFinite(item.time)
      || typeof item.quote !== 'string' || textLength(item.quote) > 40)) {
    throw new TypeError('私聊事实证据格式无效');
  }
}

function validateMentionEvidence(evidence: PrivateFactMentionEvidence[]): void {
  if (!Array.isArray(evidence) || evidence.length > 5
    || evidence.some((item) => !isMentionEvidence(item)
      || item.sessionId.length === 0 || item.messageId.length === 0)) {
    throw new TypeError('私聊事实提及证据格式无效');
  }
}

function parseArray<T>(value: unknown, field: string, isItem: (item: unknown) => item is T): T[] {
  const parsed: unknown = JSON.parse(stringValue(value, field));
  if (!Array.isArray(parsed) || parsed.some((item) => !isItem(item))) {
    throw new Error(`数据库字段 ${field} 不是有效数组`);
  }
  return parsed;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isFactEvidence(value: unknown): value is PrivateFactEvidence {
  return isRecord(value)
    && typeof value.messageId === 'string'
    && typeof value.time === 'number' && Number.isFinite(value.time)
    && typeof value.quote === 'string';
}

function isMentionEvidence(value: unknown): value is PrivateFactMentionEvidence {
  return isRecord(value)
    && typeof value.sessionId === 'string'
    && typeof value.messageId === 'string'
    && typeof value.time === 'number' && Number.isFinite(value.time);
}

export function privateFactFromRow(row: Record<string, unknown>): PrivateFactRecord {
  const level = stringValue(row.level, 'level');
  const levelSource = stringValue(row.level_source, 'level_source');
  const status = stringValue(row.status, 'status');
  if (level !== 'L0' && level !== 'L1' && level !== 'L2') throw new Error('数据库字段 level 无效');
  if (levelSource !== 'auto' && levelSource !== 'manual') throw new Error('数据库字段 level_source 无效');
  if (status !== 'active' && status !== 'deleted') throw new Error('数据库字段 status 无效');
  const keywords = parseArray(row.keywords_json, 'keywords_json', isString);
  const mentionEvidence = parseArray(row.mention_evidence_json, 'mention_evidence_json', isMentionEvidence);
  const evidence = parseArray(row.evidence_json, 'evidence_json', isFactEvidence);
  validateKeywords(keywords);
  validateMentionEvidence(mentionEvidence);
  validateEvidence(evidence);
  const text = stringValue(row.text, 'text');
  validateText(text);
  return {
    id: numberValue(row.id, 'id'),
    account: numberValue(row.account, 'account'),
    ownerId: numberValue(row.owner_id, 'owner_id'),
    sessionId: stringValue(row.session_id, 'session_id'),
    text,
    keywords,
    level,
    levelSource,
    mentions: numberValue(row.mentions, 'mentions'),
    mentionEvidence,
    evidence,
    status,
    createdAt: numberValue(row.created_at, 'created_at'),
    updatedAt: numberValue(row.updated_at, 'updated_at'),
  };
}

export function createPrivacyQueries(database: DatabaseSync): PrivacyRepository {
  const selectOwnerFacts = database.prepare(`
    SELECT id, account, owner_id, session_id, text, keywords_json, level, level_source, mentions,
      mention_evidence_json, evidence_json, status, created_at, updated_at
    FROM private_facts
    WHERE account = ? AND owner_id = ? AND status = ?
    ORDER BY updated_at DESC, id DESC
  `);
  const selectAccountFacts = database.prepare(`
    SELECT id, account, owner_id, session_id, text, keywords_json, level, level_source, mentions,
      mention_evidence_json, evidence_json, status, created_at, updated_at
    FROM private_facts
    WHERE account = ? AND status = ?
    ORDER BY updated_at DESC, id DESC
  `);
  const selectGroupFacts = database.prepare(`
    SELECT id, account, owner_id, session_id, text, keywords_json, level, level_source, mentions,
      mention_evidence_json, evidence_json, status, created_at, updated_at
    FROM private_facts AS fact
    WHERE account = ? AND status = 'active'
      AND EXISTS (
        SELECT 1 FROM messages
        WHERE session_id = ? AND sender_id = fact.owner_id AND is_self = 0
      )
    ORDER BY updated_at DESC, id DESC
  `);
  const selectFactById = database.prepare(`
    SELECT id, account, owner_id, session_id, text, keywords_json, level, level_source, mentions,
      mention_evidence_json, evidence_json, status, created_at, updated_at
    FROM private_facts WHERE id = ?
  `);
  const insertFact = database.prepare(`
    INSERT INTO private_facts
      (account, owner_id, session_id, text, keywords_json, level, level_source, mentions,
       mention_evidence_json, evidence_json, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateFact = database.prepare(`
    UPDATE private_facts
    SET text = ?, keywords_json = ?, evidence_json = ?, updated_at = ?
    WHERE id = ? AND status = 'active'
  `);
  const deleteFact = database.prepare(`
    UPDATE private_facts SET status = 'deleted', updated_at = ? WHERE id = ? AND status = 'active'
  `);
  const selectPrivacyRun = database.prepare(`
    SELECT account, session_id, last_run_at, last_message_time
    FROM privacy_runs WHERE account = ? AND session_id = ?
  `);
  const countPrivateOwnerMessages = database.prepare(`
    SELECT COUNT(*) AS count FROM messages
    WHERE session_id = ? AND sender_id = ? AND is_self = 0 AND time > ?
  `);
  const upsertPrivacyRun = database.prepare(`
    INSERT INTO privacy_runs (account, session_id, last_run_at, last_message_time)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(account, session_id) DO UPDATE SET
      last_run_at = excluded.last_run_at,
      last_message_time = excluded.last_message_time
  `);

  return {
    listPrivateFactsForOwner(account, ownerId, status = 'active') {
      validateIdentity(account, ownerId);
      const rows = selectOwnerFacts.all(account, ownerId, status) as Array<Record<string, unknown>>;
      return rows.map(privateFactFromRow);
    },

    listPrivateFactsForAccount(account, status = 'active') {
      if (!Number.isSafeInteger(account) || account <= 0
        || (status !== 'active' && status !== 'deleted')) {
        throw new RangeError('私聊事实账号或状态无效');
      }
      const rows = selectAccountFacts.all(account, status) as Array<Record<string, unknown>>;
      return rows.map(privateFactFromRow);
    },

    listPrivateFactsForGroup(account, groupSessionId) {
      if (!Number.isSafeInteger(account) || account <= 0
        || typeof groupSessionId !== 'string' || !groupSessionId.startsWith(`${account}:group:`)) {
        throw new RangeError('群聊私聊事实查询参数无效');
      }
      const rows = selectGroupFacts.all(account, groupSessionId) as Array<Record<string, unknown>>;
      return rows.map(privateFactFromRow);
    },

    countPrivateOwnerMessagesAfter(sessionId, ownerId, afterTime) {
      if (typeof sessionId !== 'string' || sessionId.length === 0
        || !Number.isSafeInteger(ownerId) || ownerId <= 0 || !Number.isFinite(afterTime)) {
        throw new RangeError('私聊新消息统计参数无效');
      }
      const row = countPrivateOwnerMessages.get(sessionId, ownerId, afterTime) as Record<string, unknown>;
      return numberValue(row.count, 'count');
    },

    privateFactById(id) {
      if (!Number.isSafeInteger(id) || id <= 0) throw new RangeError('私聊事实 id 无效');
      const row = selectFactById.get(id) as Record<string, unknown> | undefined;
      return row ? privateFactFromRow(row) : undefined;
    },

    insertPrivateFact(fact) {
      validateIdentity(fact.account, fact.ownerId);
      validateSessionId(fact.sessionId);
      validateText(fact.text);
      validateKeywords(fact.keywords);
      validateMentionEvidence(fact.mentionEvidence);
      validateEvidence(fact.evidence);
      if (!['L0', 'L1', 'L2'].includes(fact.level)
        || !['auto', 'manual'].includes(fact.levelSource)
        || !['active', 'deleted'].includes(fact.status)) {
        throw new TypeError('私聊事实等级、来源或状态无效');
      }
      if (!Number.isSafeInteger(fact.mentions) || fact.mentions < 0
        || !Number.isFinite(fact.createdAt) || !Number.isFinite(fact.updatedAt)) {
        throw new RangeError('私聊事实元数据无效');
      }
      const result = insertFact.run(
        fact.account,
        fact.ownerId,
        fact.sessionId,
        fact.text,
        JSON.stringify(fact.keywords),
        fact.level,
        fact.levelSource,
        fact.mentions,
        JSON.stringify(fact.mentionEvidence),
        JSON.stringify(fact.evidence),
        fact.status,
        fact.createdAt,
        fact.updatedAt,
      );
      return numberValue(result.lastInsertRowid, 'lastInsertRowid');
    },

    updatePrivateFact(id, update) {
      if (!Number.isSafeInteger(id) || id <= 0 || !Number.isFinite(update.updatedAt)) {
        throw new RangeError('私聊事实更新元数据无效');
      }
      validateText(update.text);
      validateKeywords(update.keywords);
      validateEvidence(update.evidence);
      updateFact.run(update.text, JSON.stringify(update.keywords), JSON.stringify(update.evidence), update.updatedAt, id);
    },

    markPrivateFactDeleted(id, updatedAt) {
      if (!Number.isSafeInteger(id) || id <= 0 || !Number.isFinite(updatedAt)) {
        throw new RangeError('私聊事实删除元数据无效');
      }
      deleteFact.run(updatedAt, id);
    },

    getPrivacyRun(account, sessionId) {
      if (!Number.isSafeInteger(account) || account <= 0
        || typeof sessionId !== 'string' || sessionId.length === 0) {
        throw new RangeError('私聊提取游标查询参数无效');
      }
      const row = selectPrivacyRun.get(account, sessionId) as Record<string, unknown> | undefined;
      if (!row) return undefined;
      return {
        account: numberValue(row.account, 'account'),
        sessionId: stringValue(row.session_id, 'session_id'),
        lastRunAt: row.last_run_at === null ? null : numberValue(row.last_run_at, 'last_run_at'),
        lastMessageTime: row.last_message_time === null ? null : numberValue(row.last_message_time, 'last_message_time'),
      };
    },

    savePrivacyRun(run) {
      if (!Number.isSafeInteger(run.account) || run.account <= 0
        || typeof run.sessionId !== 'string' || run.sessionId.length === 0
        || (run.lastRunAt !== null && !Number.isFinite(run.lastRunAt))
        || (run.lastMessageTime !== null && !Number.isFinite(run.lastMessageTime))) {
        throw new RangeError('私聊提取游标无效');
      }
      upsertPrivacyRun.run(run.account, run.sessionId, run.lastRunAt, run.lastMessageTime);
    },
  };
}
