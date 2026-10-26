import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from './types.ts';

function hasTable(database: DatabaseSync, table: string): boolean {
  return Boolean(database.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', table));
}

function columns(database: DatabaseSync, table: string): Set<string> {
  return new Set((database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map(({ name }) => name));
}

function ensureWakeFollowupJobKey(database: DatabaseSync): void {
  if (!hasTable(database, 'persona_memory_wake_followups')) {
    database.exec(`
      CREATE TABLE persona_memory_wake_followups (
        id INTEGER PRIMARY KEY,
        account INTEGER NOT NULL CHECK (account > 0),
        session_id TEXT NOT NULL CHECK (length(session_id) BETWEEN 1 AND 512),
        cycle_key TEXT NOT NULL,
        job_key TEXT NOT NULL DEFAULT 'natural' CHECK (length(job_key) BETWEEN 1 AND 128),
        message_ids_json TEXT NOT NULL CHECK (json_valid(message_ids_json)),
        mention_ids_json TEXT NOT NULL CHECK (json_valid(mention_ids_json)),
        status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'skipped', 'needs_review', 'expired')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        next_attempt_at INTEGER NOT NULL CHECK (next_attempt_at >= 0),
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
        updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
        last_reason TEXT CHECK (last_reason IS NULL OR length(last_reason) <= 120),
        UNIQUE (account, session_id, cycle_key, job_key)
      )
    `);
    return;
  }
  if (columns(database, 'persona_memory_wake_followups').has('job_key')) return;

  database.exec(`
    ALTER TABLE persona_memory_wake_followups RENAME TO persona_memory_wake_followups_v40;
    CREATE TABLE persona_memory_wake_followups (
      id INTEGER PRIMARY KEY,
      account INTEGER NOT NULL CHECK (account > 0),
      session_id TEXT NOT NULL CHECK (length(session_id) BETWEEN 1 AND 512),
      cycle_key TEXT NOT NULL,
      job_key TEXT NOT NULL DEFAULT 'natural' CHECK (length(job_key) BETWEEN 1 AND 128),
      message_ids_json TEXT NOT NULL CHECK (json_valid(message_ids_json)),
      mention_ids_json TEXT NOT NULL CHECK (json_valid(mention_ids_json)),
      status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'skipped', 'needs_review', 'expired')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      next_attempt_at INTEGER NOT NULL CHECK (next_attempt_at >= 0),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      last_reason TEXT CHECK (last_reason IS NULL OR length(last_reason) <= 120),
      UNIQUE (account, session_id, cycle_key, job_key)
    );
    INSERT INTO persona_memory_wake_followups (
      id, account, session_id, cycle_key, job_key, message_ids_json, mention_ids_json, status,
      attempt_count, next_attempt_at, created_at, expires_at, updated_at, last_reason
    )
    SELECT
      id, account, session_id, cycle_key, 'natural', message_ids_json, mention_ids_json, status,
      attempt_count, next_attempt_at, created_at, expires_at, updated_at, last_reason
    FROM persona_memory_wake_followups_v40;
    DROP TABLE persona_memory_wake_followups_v40;
  `);
}

export const migration: Migration = {
  version: 41,
  up(database) {
    ensureWakeFollowupJobKey(database);
    database.exec(`
      CREATE TABLE IF NOT EXISTS persona_memory_wake_word_jobs (
        id INTEGER PRIMARY KEY,
        account INTEGER NOT NULL CHECK (account > 0),
        session_id TEXT NOT NULL CHECK (length(session_id) BETWEEN 1 AND 512),
        cycle_key TEXT NOT NULL,
        wake_message_id TEXT NOT NULL CHECK (length(wake_message_id) BETWEEN 1 AND 512),
        bed_at INTEGER NOT NULL CHECK (bed_at >= 0),
        wake_at INTEGER NOT NULL CHECK (wake_at > bed_at),
        message_ids_json TEXT NOT NULL CHECK (json_valid(message_ids_json)),
        status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'scheduled', 'skipped', 'expired')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        next_attempt_at INTEGER NOT NULL CHECK (next_attempt_at >= 0),
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
        updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
        last_reason TEXT CHECK (last_reason IS NULL OR length(last_reason) <= 120),
        UNIQUE (account, session_id, cycle_key)
      );
      CREATE INDEX IF NOT EXISTS idx_persona_memory_wake_followups_pending
        ON persona_memory_wake_followups (account, status, next_attempt_at, expires_at);
      CREATE INDEX IF NOT EXISTS idx_persona_memory_wake_word_jobs_pending
        ON persona_memory_wake_word_jobs (account, status, next_attempt_at, expires_at);
    `);
  },
};
