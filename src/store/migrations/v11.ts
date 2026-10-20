import type { Migration } from './types.ts';

export const migration: Migration = {
  version: 11,
  up(database) {
    database.exec(`
      CREATE TABLE private_facts (
        id INTEGER PRIMARY KEY,
        account INTEGER NOT NULL,
        owner_id INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        text TEXT NOT NULL,
        keywords_json TEXT NOT NULL,
        level TEXT NOT NULL CHECK (level IN ('L0', 'L1', 'L2')),
        level_source TEXT NOT NULL CHECK (level_source IN ('auto', 'manual')),
        mentions INTEGER NOT NULL DEFAULT 0 CHECK (mentions >= 0),
        mention_evidence_json TEXT NOT NULL DEFAULT '[]',
        evidence_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL CHECK (status IN ('active', 'deleted')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_private_facts_owner_status ON private_facts (account, owner_id, status);

      CREATE TABLE privacy_runs (
        account INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        last_run_at INTEGER,
        last_message_time INTEGER,
        PRIMARY KEY (account, session_id)
      );
    `);
  },
};
