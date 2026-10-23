import type { DatabaseSync } from 'node:sqlite';

export type EventAdvocacyStatus =
  | 'awaiting_confirmation'
  | 'confirmed'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'cancelled';
export type EventAdvocacyFailureCode = 'adapter_error' | 'delivery_unknown';

export interface StoredEventAdvocacy {
  account: number;
  eventId: number;
  ownerId: number;
  sourceSessionId: string;
  requestedAt: number;
  status: EventAdvocacyStatus;
  promptMessageId?: string;
  promptedAt?: number;
  confirmationMessageId?: string;
  confirmedAt?: number;
  claimedAt?: number;
  sentMessageId?: string;
  sentAt?: number;
  failureCode?: EventAdvocacyFailureCode;
  createdAt: number;
  updatedAt: number;
}

export interface EventAdvocacyRepository {
  ensureEventAdvocacyPending(input: {
    account: number;
    eventId: number;
    ownerId: number;
    sourceSessionId: string;
    requestedAt: number;
  }): StoredEventAdvocacy | undefined;
  eventAdvocacyByEvent(account: number, eventId: number): StoredEventAdvocacy | undefined;
  listEventAdvocaciesForOwner(account: number, ownerId: number): StoredEventAdvocacy[];
  listConfirmedEventAdvocacies(account: number, limit: number): StoredEventAdvocacy[];
  markEventAdvocacyPrompted(input: {
    account: number;
    eventId: number;
    ownerId: number;
    promptMessageId: string;
    promptedAt: number;
  }): boolean;
  confirmEventAdvocacy(input: {
    account: number;
    eventId: number;
    ownerId: number;
    promptMessageId: string;
    confirmationMessageId: string;
    confirmedAt: number;
  }): boolean;
  claimEventAdvocacy(account: number, eventId: number, claimedAt: number): boolean;
  finishEventAdvocacy(input: {
    account: number;
    eventId: number;
    status: 'sent';
    sentMessageId: string;
    sentAt: number;
    updatedAt: number;
  } | {
    account: number;
    eventId: number;
    status: 'failed';
    failureCode: EventAdvocacyFailureCode;
    updatedAt: number;
  }): boolean;
  cancelEventAdvocacy(account: number, eventId: number, ownerId: number, updatedAt: number): boolean;
}

function validId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function validTime(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${field} 无效`);
}

function validMessageId(value: string, field: string): string {
  const messageId = value.trim();
  if (messageId.length < 1 || messageId.length > 512) throw new RangeError(`${field} 无效`);
  return messageId;
}

function numberValue(value: unknown, field: string): number {
  const number = typeof value === 'bigint' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isSafeInteger(number)) {
    throw new Error(`数据库字段 ${field} 不是安全整数`);
  }
  return number;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value === 'string') return value;
  throw new Error(`数据库字段 ${field} 不是文本`);
}

function optionalNumber(value: unknown, field: string): number | undefined {
  return value === null || value === undefined ? undefined : numberValue(value, field);
}

function optionalString(value: unknown, field: string): string | undefined {
  return value === null || value === undefined ? undefined : stringValue(value, field);
}

function changed(result: { changes: number | bigint }): boolean {
  return Number(result.changes) > 0;
}

function mapEventAdvocacy(row: Record<string, unknown>): StoredEventAdvocacy {
  const status = stringValue(row.status, 'status');
  if (!['awaiting_confirmation', 'confirmed', 'sending', 'sent', 'failed', 'cancelled'].includes(status)) {
    throw new Error('数据库字段 event advocacy 状态无效');
  }
  const failureCode = optionalString(row.failure_code, 'failure_code');
  if (failureCode !== undefined && failureCode !== 'adapter_error' && failureCode !== 'delivery_unknown') {
    throw new Error('数据库字段 event advocacy failure_code 无效');
  }
  return {
    account: numberValue(row.account, 'account'),
    eventId: numberValue(row.event_id, 'event_id'),
    ownerId: numberValue(row.owner_id, 'owner_id'),
    sourceSessionId: stringValue(row.source_session_id, 'source_session_id'),
    requestedAt: numberValue(row.requested_at, 'requested_at'),
    status: status as EventAdvocacyStatus,
    ...(optionalString(row.prompt_message_id, 'prompt_message_id') === undefined
      ? {} : { promptMessageId: optionalString(row.prompt_message_id, 'prompt_message_id') }),
    ...(optionalNumber(row.prompted_at, 'prompted_at') === undefined
      ? {} : { promptedAt: optionalNumber(row.prompted_at, 'prompted_at') }),
    ...(optionalString(row.confirmation_message_id, 'confirmation_message_id') === undefined
      ? {} : { confirmationMessageId: optionalString(row.confirmation_message_id, 'confirmation_message_id') }),
    ...(optionalNumber(row.confirmed_at, 'confirmed_at') === undefined
      ? {} : { confirmedAt: optionalNumber(row.confirmed_at, 'confirmed_at') }),
    ...(optionalNumber(row.claimed_at, 'claimed_at') === undefined
      ? {} : { claimedAt: optionalNumber(row.claimed_at, 'claimed_at') }),
    ...(optionalString(row.sent_message_id, 'sent_message_id') === undefined
      ? {} : { sentMessageId: optionalString(row.sent_message_id, 'sent_message_id') }),
    ...(optionalNumber(row.sent_at, 'sent_at') === undefined
      ? {} : { sentAt: optionalNumber(row.sent_at, 'sent_at') }),
    ...(failureCode === undefined ? {} : { failureCode: failureCode as EventAdvocacyFailureCode }),
    createdAt: numberValue(row.created_at, 'created_at'),
    updatedAt: numberValue(row.updated_at, 'updated_at'),
  };
}

const SELECT_COLUMNS = `
  account, event_id, owner_id, source_session_id, requested_at, status,
  prompt_message_id, prompted_at, confirmation_message_id, confirmed_at,
  claimed_at, sent_message_id, sent_at, failure_code, created_at, updated_at
`;

export function createEventAdvocacyRepository(database: DatabaseSync): EventAdvocacyRepository {
  const selectActiveAdvocateNote = database.prepare(`
    SELECT source_session_id FROM event_notes
    WHERE account = ? AND event_id = ? AND owner_id = ? AND intent = 'advocate' AND status = 'active'
  `);
  const insertPending = database.prepare(`
    INSERT INTO event_advocacies (
      account, event_id, owner_id, source_session_id, requested_at, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'awaiting_confirmation', ?, ?)
    ON CONFLICT (event_id) DO UPDATE SET
      account = excluded.account,
      owner_id = excluded.owner_id,
      source_session_id = excluded.source_session_id,
      requested_at = excluded.requested_at,
      status = 'awaiting_confirmation',
      prompt_message_id = NULL,
      prompted_at = NULL,
      confirmation_message_id = NULL,
      confirmed_at = NULL,
      claimed_at = NULL,
      sent_message_id = NULL,
      sent_at = NULL,
      failure_code = NULL,
      updated_at = excluded.updated_at
    WHERE event_advocacies.status = 'cancelled'
  `);
  const selectByEvent = database.prepare(`
    SELECT ${SELECT_COLUMNS} FROM event_advocacies WHERE account = ? AND event_id = ?
  `);
  const selectForOwner = database.prepare(`
    SELECT ${SELECT_COLUMNS} FROM event_advocacies
    WHERE account = ? AND owner_id = ?
    ORDER BY updated_at DESC, event_id DESC
  `);
  const selectConfirmed = database.prepare(`
    SELECT ${SELECT_COLUMNS} FROM event_advocacies
    WHERE account = ? AND status = 'confirmed'
    ORDER BY confirmed_at, event_id
    LIMIT ?
  `);
  const markPrompted = database.prepare(`
    UPDATE event_advocacies
    SET prompt_message_id = ?, prompted_at = ?, updated_at = ?
    WHERE account = ? AND event_id = ? AND owner_id = ?
      AND status = 'awaiting_confirmation' AND prompt_message_id IS NULL AND ? >= requested_at
  `);
  const confirm = database.prepare(`
    UPDATE event_advocacies
    SET status = 'confirmed', confirmation_message_id = ?, confirmed_at = ?, updated_at = ?
    WHERE account = ? AND event_id = ? AND owner_id = ?
      AND status = 'awaiting_confirmation' AND prompt_message_id = ?
      AND prompted_at IS NOT NULL AND ? >= prompted_at
  `);
  const claim = database.prepare(`
    UPDATE event_advocacies
    SET status = 'sending', claimed_at = ?, updated_at = ?
    WHERE account = ? AND event_id = ? AND status = 'confirmed'
      AND confirmed_at IS NOT NULL AND ? >= confirmed_at
  `);
  const complete = database.prepare(`
    UPDATE event_advocacies
    SET status = ?, sent_message_id = ?, sent_at = ?, failure_code = ?, updated_at = ?
    WHERE account = ? AND event_id = ? AND status = 'sending'
      AND claimed_at IS NOT NULL AND ? >= claimed_at
  `);
  const cancel = database.prepare(`
    UPDATE event_advocacies SET status = 'cancelled', updated_at = ?
    WHERE account = ? AND event_id = ? AND owner_id = ?
      AND status IN ('awaiting_confirmation', 'confirmed')
  `);

  function one(row: unknown): StoredEventAdvocacy | undefined {
    return row === undefined ? undefined : mapEventAdvocacy(row as Record<string, unknown>);
  }

  function many(rows: unknown): StoredEventAdvocacy[] {
    return (rows as Array<Record<string, unknown>>).map(mapEventAdvocacy);
  }

  return {
    ensureEventAdvocacyPending(input) {
      if (!validId(input.account) || !validId(input.eventId) || !validId(input.ownerId)) {
        throw new RangeError('事件出面账号、事件与主人必须是正整数');
      }
      const sourceSessionId = input.sourceSessionId.trim();
      if (sourceSessionId.length < 1 || sourceSessionId.length > 512) {
        throw new RangeError('事件出面来源会话无效');
      }
      validTime(input.requestedAt, '事件出面请求时间');
      const note = selectActiveAdvocateNote.get(input.account, input.eventId, input.ownerId) as
        { source_session_id: unknown } | undefined;
      if (!note || stringValue(note.source_session_id, 'source_session_id') !== sourceSessionId) return undefined;
      insertPending.run(
        input.account,
        input.eventId,
        input.ownerId,
        sourceSessionId,
        input.requestedAt,
        input.requestedAt,
        input.requestedAt,
      );
      return one(selectByEvent.get(input.account, input.eventId));
    },

    eventAdvocacyByEvent(account, eventId) {
      if (!validId(account) || !validId(eventId)) throw new RangeError('事件出面查询范围无效');
      return one(selectByEvent.get(account, eventId));
    },

    listEventAdvocaciesForOwner(account, ownerId) {
      if (!validId(account) || !validId(ownerId)) throw new RangeError('事件出面主人查询范围无效');
      return many(selectForOwner.all(account, ownerId));
    },

    listConfirmedEventAdvocacies(account, limit) {
      if (!validId(account) || !Number.isSafeInteger(limit) || limit < 0) {
        throw new RangeError('已确认事件出面查询范围无效');
      }
      if (limit === 0) return [];
      return many(selectConfirmed.all(account, limit));
    },

    markEventAdvocacyPrompted(input) {
      if (!validId(input.account) || !validId(input.eventId) || !validId(input.ownerId)) {
        throw new RangeError('事件出面确认提示范围无效');
      }
      const promptMessageId = validMessageId(input.promptMessageId, '确认提示消息 ID');
      validTime(input.promptedAt, '确认提示时间');
      return changed(markPrompted.run(
        promptMessageId,
        input.promptedAt,
        input.promptedAt,
        input.account,
        input.eventId,
        input.ownerId,
        input.promptedAt,
      ));
    },

    confirmEventAdvocacy(input) {
      if (!validId(input.account) || !validId(input.eventId) || !validId(input.ownerId)) {
        throw new RangeError('事件出面确认范围无效');
      }
      const promptMessageId = validMessageId(input.promptMessageId, '确认提示消息 ID');
      const confirmationMessageId = validMessageId(input.confirmationMessageId, '确认消息 ID');
      validTime(input.confirmedAt, '确认时间');
      return changed(confirm.run(
        confirmationMessageId,
        input.confirmedAt,
        input.confirmedAt,
        input.account,
        input.eventId,
        input.ownerId,
        promptMessageId,
        input.confirmedAt,
      ));
    },

    claimEventAdvocacy(account, eventId, claimedAt) {
      if (!validId(account) || !validId(eventId)) throw new RangeError('事件出面认领范围无效');
      validTime(claimedAt, '事件出面认领时间');
      return changed(claim.run(claimedAt, claimedAt, account, eventId, claimedAt));
    },

    finishEventAdvocacy(input) {
      if (!validId(input.account) || !validId(input.eventId)) throw new RangeError('事件出面完成范围无效');
      validTime(input.updatedAt, '事件出面完成时间');
      if (input.status === 'sent') {
        const sentMessageId = validMessageId(input.sentMessageId, '出面消息 ID');
        validTime(input.sentAt, '出面发送时间');
        if (input.updatedAt < input.sentAt) throw new RangeError('事件出面完成时间早于发送时间');
        return changed(complete.run(
          'sent', sentMessageId, input.sentAt, null, input.updatedAt,
          input.account, input.eventId, input.sentAt,
        ));
      }
      if (input.failureCode !== 'adapter_error' && input.failureCode !== 'delivery_unknown') {
        throw new RangeError('事件出面失败类别无效');
      }
      return changed(complete.run(
        'failed', null, null, input.failureCode, input.updatedAt,
        input.account, input.eventId, input.updatedAt,
      ));
    },

    cancelEventAdvocacy(account, eventId, ownerId, updatedAt) {
      if (!validId(account) || !validId(eventId) || !validId(ownerId)) {
        throw new RangeError('事件出面撤销范围无效');
      }
      validTime(updatedAt, '事件出面撤销时间');
      return changed(cancel.run(updatedAt, account, eventId, ownerId));
    },
  };
}
