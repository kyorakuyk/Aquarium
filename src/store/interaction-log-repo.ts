import type { DatabaseSync } from 'node:sqlite';

export type InteractionActionKind = 'react' | 'poke' | 'recall' | 'mute' | 'essence';
export type InteractionSource = 'rule' | 'llm' | 'owner_command';
export type InteractionVerdict = 'executed' | 'dry_run' | 'blocked' | 'failed';

export interface InteractionLogInput {
  account: number;
  time: number;
  sessionId: string;
  messageId?: string;
  actionKind: InteractionActionKind;
  target?: string;
  details?: Record<string, string | number | boolean>;
  source: InteractionSource;
  verdict: InteractionVerdict;
  reason: string;
}

export interface StoredInteractionLog extends InteractionLogInput {
  id: number;
}

export interface InteractionLogRepository {
  recordInteractionLog(input: InteractionLogInput): number;
  interactionLogsForMessage(sessionId: string, messageId: string): StoredInteractionLog[];
  countAllowedForAccount(account: number, fromTime: number, toTime: number, actionKind?: InteractionActionKind): number;
  countAllowedForSession(sessionId: string, actionKind: InteractionActionKind, fromTime: number, toTime: number): number;
  latestAllowedForTarget(account: number, actionKind: InteractionActionKind, target: string): StoredInteractionLog | undefined;
  recentOutcomesForAction(sessionId: string, actionKind: InteractionActionKind, limit: number): StoredInteractionLog[];
}

export function createInteractionLogRepository(database: DatabaseSync): InteractionLogRepository {
  const insert = database.prepare(`
    INSERT INTO interaction_log
      (account, time, session_id, message_id, action_kind, target, details_json, source, verdict, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const forMessage = database.prepare(`
    SELECT id, account, time, session_id, message_id, action_kind, target, details_json, source, verdict, reason
    FROM interaction_log
    WHERE session_id = ? AND message_id = ?
    ORDER BY id ASC
  `);
  const countAccount = database.prepare(`
    SELECT COUNT(*) AS count FROM interaction_log
    WHERE account = ? AND time >= ? AND time <= ?
      AND verdict IN ('executed', 'dry_run', 'failed')
      AND (? IS NULL OR action_kind = ?)
  `);
  const countSession = database.prepare(`
    SELECT COUNT(*) AS count FROM interaction_log
    WHERE session_id = ? AND action_kind = ? AND time >= ? AND time <= ?
      AND verdict IN ('executed', 'dry_run', 'failed')
  `);
  const latestTarget = database.prepare(`
    SELECT id, account, time, session_id, message_id, action_kind, target, details_json, source, verdict, reason
    FROM interaction_log
    WHERE account = ? AND action_kind = ? AND target = ?
      AND verdict IN ('executed', 'dry_run', 'failed')
    ORDER BY time DESC, id DESC LIMIT 1
  `);
  const recentOutcomes = database.prepare(`
    SELECT id, account, time, session_id, message_id, action_kind, target, details_json, source, verdict, reason
    FROM interaction_log
    WHERE session_id = ? AND action_kind = ? AND verdict IN ('executed', 'failed')
    ORDER BY time DESC, id DESC LIMIT ?
  `);

  function mapRow(row: unknown): StoredInteractionLog {
    const stored = row as Record<string, unknown>;
    const detailsJson = String(stored.details_json ?? '{}');
    const parsed = JSON.parse(detailsJson) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new TypeError('Interaction log details must be a JSON object');
    }
    return {
      id: Number(stored.id),
      account: Number(stored.account),
      time: Number(stored.time),
      sessionId: String(stored.session_id),
      ...(stored.message_id === null ? {} : { messageId: String(stored.message_id) }),
      actionKind: String(stored.action_kind) as InteractionActionKind,
      ...(stored.target === null ? {} : { target: String(stored.target) }),
      ...(Object.keys(parsed).length === 0 ? {} : { details: parsed as InteractionLogInput['details'] }),
      source: String(stored.source) as InteractionSource,
      verdict: String(stored.verdict) as InteractionVerdict,
      reason: String(stored.reason),
    };
  }

  return {
    recordInteractionLog(input) {
      const detailsJson = JSON.stringify(input.details ?? {});
      if (!Number.isSafeInteger(input.account) || input.account <= 0
        || !Number.isSafeInteger(input.time) || input.time < 0
        || input.sessionId.length < 1 || input.sessionId.length > 512
        || (input.messageId !== undefined && (input.messageId.length < 1 || input.messageId.length > 512))
        || (input.target !== undefined && (input.target.length < 1 || input.target.length > 512))
        || input.reason.length < 1 || input.reason.length > 128
        || detailsJson.length > 2048) {
        throw new TypeError('Invalid interaction log record');
      }
      const result = insert.run(
        input.account,
        input.time,
        input.sessionId,
        input.messageId ?? null,
        input.actionKind,
        input.target ?? null,
        detailsJson,
        input.source,
        input.verdict,
        input.reason,
      );
      return Number(result.lastInsertRowid);
    },
    interactionLogsForMessage(sessionId, messageId) {
      return forMessage.all(sessionId, messageId).map(mapRow);
    },
    countAllowedForAccount(account, fromTime, toTime, actionKind) {
      const row = countAccount.get(account, fromTime, toTime, actionKind ?? null, actionKind ?? null) as { count: number };
      return Number(row.count);
    },
    countAllowedForSession(sessionId, actionKind, fromTime, toTime) {
      const row = countSession.get(sessionId, actionKind, fromTime, toTime) as { count: number };
      return Number(row.count);
    },
    latestAllowedForTarget(account, actionKind, target) {
      const row = latestTarget.get(account, actionKind, target);
      return row === undefined ? undefined : mapRow(row);
    },
    recentOutcomesForAction(sessionId, actionKind, limit) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new RangeError('Invalid interaction outcome limit');
      return recentOutcomes.all(sessionId, actionKind, limit).map(mapRow);
    },
  };
}
