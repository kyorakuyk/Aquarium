import type { Migration } from './types.ts';

export const migration: Migration = {
  version: 26,
  up(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS persona_memos (
        id INTEGER PRIMARY KEY,
        account INTEGER NOT NULL CHECK (account > 0),
        session_id TEXT NOT NULL CHECK (length(session_id) BETWEEN 1 AND 512),
        message_id TEXT NOT NULL CHECK (length(message_id) BETWEEN 1 AND 512),
        sender_id INTEGER NOT NULL CHECK (sender_id > 0),
        sender_name TEXT NOT NULL CHECK (length(sender_name) BETWEEN 1 AND 120),
        is_self INTEGER NOT NULL CHECK (is_self IN (0, 1)),
        text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 2000),
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        processed_cycle_key TEXT,
        UNIQUE (account, session_id, message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_persona_memos_account_created
      ON persona_memos (account, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_persona_memos_pending
      ON persona_memos (account, processed_cycle_key, created_at);

      CREATE TABLE IF NOT EXISTS persona_diaries (
        id INTEGER PRIMARY KEY,
        account INTEGER NOT NULL CHECK (account > 0),
        cycle_key TEXT NOT NULL CHECK (length(cycle_key) = 10),
        text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 4000),
        source_entries_json TEXT NOT NULL DEFAULT '[]',
        visible_to_ani INTEGER NOT NULL DEFAULT 1 CHECK (visible_to_ani IN (0, 1)),
        source_count INTEGER NOT NULL DEFAULT 0 CHECK (source_count >= 0),
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        UNIQUE (account, cycle_key)
      );
      CREATE INDEX IF NOT EXISTS idx_persona_diaries_account_created
      ON persona_diaries (account, created_at DESC, id DESC);

      CREATE TABLE IF NOT EXISTS persona_memory_runs (
        account INTEGER NOT NULL CHECK (account > 0),
        cycle_key TEXT NOT NULL CHECK (length(cycle_key) = 10),
        status TEXT NOT NULL CHECK (status IN ('running', 'done', 'budget', 'failed', 'empty', 'partial')),
        reason TEXT,
        memo_count INTEGER NOT NULL DEFAULT 0 CHECK (memo_count >= 0),
        processed_count INTEGER NOT NULL DEFAULT 0 CHECK (processed_count >= 0),
        started_at INTEGER NOT NULL CHECK (started_at >= 0),
        finished_at INTEGER,
        PRIMARY KEY (account, cycle_key)
      );
    `);
  },
};
