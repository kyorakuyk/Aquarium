import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from './types.ts';

function hasTable(database: DatabaseSync, table: string): boolean {
  return Boolean(database.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', table));
}

function ensureTable(database: DatabaseSync, table: string, createSql: string, columns: readonly string[]): void {
  if (!hasTable(database, table)) database.exec(createSql);
  const existing = new Set((database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map(({ name }) => name));
  if (columns.some((column) => !existing.has(column))) {
    throw new Error(`v40 检查失败：${table} 表结构不完整`);
  }
}

export const migration: Migration = {
  version: 40,
  up(database) {
    ensureTable(database, 'persona_memory_sleep_contexts', `
      CREATE TABLE persona_memory_sleep_contexts (
        id INTEGER PRIMARY KEY,
        account INTEGER NOT NULL CHECK (account > 0),
        session_id TEXT NOT NULL CHECK (length(session_id) BETWEEN 1 AND 512),
        cycle_key TEXT NOT NULL,
        source_entries_json TEXT NOT NULL CHECK (json_valid(source_entries_json)),
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
        UNIQUE (account, session_id, cycle_key)
      )
    `, [
      'id', 'account', 'session_id', 'cycle_key', 'source_entries_json', 'created_at', 'expires_at',
    ]);
    ensureTable(database, 'persona_memory_wake_followups', `
      CREATE TABLE persona_memory_wake_followups (
        id INTEGER PRIMARY KEY,
        account INTEGER NOT NULL CHECK (account > 0),
        session_id TEXT NOT NULL CHECK (length(session_id) BETWEEN 1 AND 512),
        cycle_key TEXT NOT NULL,
        message_ids_json TEXT NOT NULL CHECK (json_valid(message_ids_json)),
        mention_ids_json TEXT NOT NULL CHECK (json_valid(mention_ids_json)),
        status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'skipped', 'needs_review', 'expired')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        next_attempt_at INTEGER NOT NULL CHECK (next_attempt_at >= 0),
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
        updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
        last_reason TEXT CHECK (last_reason IS NULL OR length(last_reason) <= 120),
        UNIQUE (account, session_id, cycle_key)
      )
    `, [
      'id', 'account', 'session_id', 'cycle_key', 'message_ids_json', 'mention_ids_json', 'status',
      'attempt_count', 'next_attempt_at', 'created_at', 'expires_at', 'updated_at', 'last_reason',
    ]);
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_persona_memory_sleep_contexts_expiry
        ON persona_memory_sleep_contexts (account, session_id, expires_at);
      CREATE INDEX IF NOT EXISTS idx_persona_memory_wake_followups_pending
        ON persona_memory_wake_followups (account, status, next_attempt_at, expires_at);
    `);
  },
};
