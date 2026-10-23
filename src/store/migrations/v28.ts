import type { Migration } from './types.ts';

export const migration: Migration = {
  version: 28,
  up(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY,
        account INTEGER NOT NULL CHECK (account > 0),
        source_group_id INTEGER NOT NULL CHECK (source_group_id > 0),
        anchor_message_id TEXT NOT NULL CHECK (length(anchor_message_id) BETWEEN 1 AND 512),
        title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 16),
        summary TEXT NOT NULL CHECK (length(trim(summary)) BETWEEN 1 AND 60),
        participant_ids_json TEXT NOT NULL DEFAULT '[]',
        evidence_message_ids_json TEXT NOT NULL DEFAULT '[]',
        occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
        UNIQUE (account, source_group_id, anchor_message_id, title),
        UNIQUE (id, account)
      );
      CREATE INDEX IF NOT EXISTS idx_events_account_group_time
      ON events (account, source_group_id, occurred_at DESC, id DESC);

      CREATE TABLE IF NOT EXISTS event_notes (
        id INTEGER PRIMARY KEY,
        account INTEGER NOT NULL CHECK (account > 0),
        event_id INTEGER NOT NULL,
        owner_id INTEGER NOT NULL CHECK (owner_id > 0),
        source_session_id TEXT NOT NULL CHECK (length(source_session_id) BETWEEN 1 AND 512),
        text TEXT NOT NULL CHECK (length(trim(text)) BETWEEN 1 AND 4000),
        intent TEXT NOT NULL DEFAULT 'confide' CHECK (intent IN ('confide', 'clarify', 'advocate')),
        level TEXT NOT NULL DEFAULT 'L0' CHECK (level IN ('L0', 'L1', 'L2')),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retracted')),
        source_message_ids_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
        UNIQUE (event_id, owner_id),
        FOREIGN KEY (event_id, account) REFERENCES events (id, account) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_event_notes_account_event
      ON event_notes (account, event_id, status, level);
    `);
  },
};
