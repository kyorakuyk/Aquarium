import type { DatabaseSync } from 'node:sqlite';

export type PersonaCounterpartClaimStatus = 'pending' | 'dismissed';

export interface PersonaCounterpartBinding {
  account: number;
  personaId: string;
  counterpartName: string;
  userId: number;
  createdAt: number;
}

export interface PersonaCounterpartClaim {
  account: number;
  personaId: string;
  counterpartName: string;
  userId: number;
  sessionId: string;
  evidence: string;
  firstSeen: number;
  lastSeen: number;
  status: PersonaCounterpartClaimStatus;
}

export type PersonaCounterpartClaimInput = Omit<PersonaCounterpartClaim, 'status'>;

export interface PersonaCounterpartRepository {
  listPersonaCounterpartBindings(account: number, personaId: string): PersonaCounterpartBinding[];
  createPersonaCounterpartBinding(input: PersonaCounterpartBinding): PersonaCounterpartBinding;
  deletePersonaCounterpartBinding(
    account: number,
    personaId: string,
    counterpartName: string,
    userId: number,
  ): boolean;
  listPersonaCounterpartClaims(account: number, personaId: string): PersonaCounterpartClaim[];
  upsertPersonaCounterpartClaim(input: PersonaCounterpartClaimInput): PersonaCounterpartClaim;
  dismissPersonaCounterpartClaim(
    account: number,
    personaId: string,
    counterpartName: string,
    userId: number,
  ): PersonaCounterpartClaim | undefined;
  deletePersonaCounterpartClaim(
    account: number,
    personaId: string,
    counterpartName: string,
    userId: number,
  ): boolean;
}

function integer(value: unknown, field: string): number {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'bigint') {
    const result = Number(value);
    if (Number.isSafeInteger(result)) return result;
  }
  throw new Error(`数据库字段 ${field} 不是安全整数`);
}

function requiredText(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.length > maximum) {
    throw new Error(`数据库字段 ${field} 无效`);
  }
  return value;
}

function positiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${field} 必须是正整数`);
}

function timestamp(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${field} 必须是非负整数`);
}

function bindingRecord(row: Record<string, unknown>): PersonaCounterpartBinding {
  return {
    account: integer(row.account, 'account'),
    personaId: requiredText(row.persona_id, 'persona_id', 128),
    counterpartName: requiredText(row.counterpart_name, 'counterpart_name', 80),
    userId: integer(row.user_id, 'user_id'),
    createdAt: integer(row.created_at, 'created_at'),
  };
}

function claimRecord(row: Record<string, unknown>): PersonaCounterpartClaim {
  const status = requiredText(row.status, 'status', 16);
  if (status !== 'pending' && status !== 'dismissed') throw new Error('数据库字段 status 无效');
  const firstSeen = integer(row.first_seen, 'first_seen');
  const lastSeen = integer(row.last_seen, 'last_seen');
  if (lastSeen < firstSeen) throw new Error('数据库字段 last_seen 早于 first_seen');
  return {
    account: integer(row.account, 'account'),
    personaId: requiredText(row.persona_id, 'persona_id', 128),
    counterpartName: requiredText(row.counterpart_name, 'counterpart_name', 80),
    userId: integer(row.user_id, 'user_id'),
    sessionId: requiredText(row.session_id, 'session_id', 512),
    evidence: requiredText(row.evidence, 'evidence', 512),
    firstSeen,
    lastSeen,
    status,
  };
}

export function createPersonaCounterpartQueries(database: DatabaseSync): PersonaCounterpartRepository {
  const selectBindings = database.prepare(`
    SELECT account, persona_id, counterpart_name, user_id, created_at
    FROM persona_counterpart_bindings
    WHERE account = ? AND persona_id = ?
    ORDER BY counterpart_name, user_id
  `);
  const selectBinding = database.prepare(`
    SELECT account, persona_id, counterpart_name, user_id, created_at
    FROM persona_counterpart_bindings
    WHERE account = ? AND persona_id = ? AND counterpart_name = ? AND user_id = ?
  `);
  const insertBinding = database.prepare(`
    INSERT OR IGNORE INTO persona_counterpart_bindings
      (account, persona_id, counterpart_name, user_id, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const removeBinding = database.prepare(`
    DELETE FROM persona_counterpart_bindings
    WHERE account = ? AND persona_id = ? AND counterpart_name = ? AND user_id = ?
  `);
  const selectClaims = database.prepare(`
    SELECT account, persona_id, counterpart_name, user_id, session_id, evidence, first_seen, last_seen, status
    FROM persona_counterpart_claims
    WHERE account = ? AND persona_id = ?
    ORDER BY last_seen DESC, counterpart_name, user_id
  `);
  const selectClaim = database.prepare(`
    SELECT account, persona_id, counterpart_name, user_id, session_id, evidence, first_seen, last_seen, status
    FROM persona_counterpart_claims
    WHERE account = ? AND persona_id = ? AND counterpart_name = ? AND user_id = ?
  `);
  const upsertClaim = database.prepare(`
    INSERT INTO persona_counterpart_claims
      (account, persona_id, counterpart_name, user_id, session_id, evidence, first_seen, last_seen, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    ON CONFLICT(account, persona_id, counterpart_name, user_id) DO UPDATE SET
      session_id = excluded.session_id,
      evidence = excluded.evidence,
      last_seen = MAX(persona_counterpart_claims.last_seen, excluded.last_seen)
    WHERE persona_counterpart_claims.status = 'pending'
  `);
  const dismissClaim = database.prepare(`
    UPDATE persona_counterpart_claims SET status = 'dismissed'
    WHERE account = ? AND persona_id = ? AND counterpart_name = ? AND user_id = ?
  `);
  const removeClaim = database.prepare(`
    DELETE FROM persona_counterpart_claims
    WHERE account = ? AND persona_id = ? AND counterpart_name = ? AND user_id = ?
  `);

  function validateKey(account: number, personaId: string, counterpartName?: string, userId?: number): void {
    positiveInteger(account, 'account');
    requiredText(personaId, 'personaId', 128);
    if (counterpartName !== undefined) requiredText(counterpartName, 'counterpartName', 80);
    if (userId !== undefined) positiveInteger(userId, 'userId');
  }

  function readBinding(account: number, personaId: string, name: string, userId: number): PersonaCounterpartBinding {
    const row = selectBinding.get(account, personaId, name, userId) as Record<string, unknown> | undefined;
    if (!row) throw new Error('原作对象绑定写入后无法读取');
    return bindingRecord(row);
  }

  function readClaim(account: number, personaId: string, name: string, userId: number): PersonaCounterpartClaim | undefined {
    const row = selectClaim.get(account, personaId, name, userId) as Record<string, unknown> | undefined;
    return row ? claimRecord(row) : undefined;
  }

  return {
    listPersonaCounterpartBindings(account, personaId) {
      validateKey(account, personaId);
      return (selectBindings.all(account, personaId) as Array<Record<string, unknown>>).map(bindingRecord);
    },
    createPersonaCounterpartBinding(input) {
      validateKey(input.account, input.personaId, input.counterpartName, input.userId);
      timestamp(input.createdAt, 'createdAt');
      insertBinding.run(input.account, input.personaId, input.counterpartName, input.userId, input.createdAt);
      return readBinding(input.account, input.personaId, input.counterpartName, input.userId);
    },
    deletePersonaCounterpartBinding(account, personaId, counterpartName, userId) {
      validateKey(account, personaId, counterpartName, userId);
      return removeBinding.run(account, personaId, counterpartName, userId).changes > 0;
    },
    listPersonaCounterpartClaims(account, personaId) {
      validateKey(account, personaId);
      return (selectClaims.all(account, personaId) as Array<Record<string, unknown>>).map(claimRecord);
    },
    upsertPersonaCounterpartClaim(input) {
      validateKey(input.account, input.personaId, input.counterpartName, input.userId);
      requiredText(input.sessionId, 'sessionId', 512);
      requiredText(input.evidence, 'evidence', 512);
      timestamp(input.firstSeen, 'firstSeen');
      timestamp(input.lastSeen, 'lastSeen');
      if (input.lastSeen < input.firstSeen) throw new RangeError('lastSeen 不得早于 firstSeen');
      upsertClaim.run(
        input.account,
        input.personaId,
        input.counterpartName,
        input.userId,
        input.sessionId,
        input.evidence,
        input.firstSeen,
        input.lastSeen,
      );
      const result = readClaim(input.account, input.personaId, input.counterpartName, input.userId);
      if (!result) throw new Error('原作对象 claim 写入后无法读取');
      return result;
    },
    dismissPersonaCounterpartClaim(account, personaId, counterpartName, userId) {
      validateKey(account, personaId, counterpartName, userId);
      dismissClaim.run(account, personaId, counterpartName, userId);
      return readClaim(account, personaId, counterpartName, userId);
    },
    deletePersonaCounterpartClaim(account, personaId, counterpartName, userId) {
      validateKey(account, personaId, counterpartName, userId);
      return removeClaim.run(account, personaId, counterpartName, userId).changes > 0;
    },
  };
}
