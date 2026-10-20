import type { Migration } from './types.ts';

export const migration: Migration = {
  version: 4,
  up(database) {
    database.exec(`
      CREATE TABLE mood_state (
        account INTEGER PRIMARY KEY,
        valence REAL NOT NULL,
        arousal REAL NOT NULL,
        updated_at INTEGER NOT NULL,
        band TEXT NOT NULL CHECK (band IN ('low', 'annoyed', 'calm', 'happy', 'excited')),
        band_since INTEGER NOT NULL,
        last_band_change_at INTEGER NOT NULL
      );

      CREATE TABLE mood_events (
        id INTEGER PRIMARY KEY,
        account INTEGER NOT NULL,
        time INTEGER NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('appraise', 'rule', 'band')),
        session_id TEXT,
        sender_id INTEGER,
        dv REAL NOT NULL,
        da REAL NOT NULL,
        applied_dv REAL NOT NULL,
        applied_da REAL NOT NULL,
        reason TEXT NOT NULL,
        band_before TEXT,
        band_after TEXT
      );
      CREATE INDEX idx_mood_events_account_time ON mood_events (account, time);

      CREATE TABLE tags (
        id INTEGER PRIMARY KEY,
        account INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        user_id INTEGER,
        text TEXT NOT NULL,
        norm TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('candidate', 'confirmed', 'rejected', 'superseded')),
        source TEXT NOT NULL CHECK (source IN ('auto', 'manual')),
        samples INTEGER NOT NULL,
        evidence_json TEXT NOT NULL,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        superseded_by INTEGER,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_tags_subject ON tags (account, session_id, user_id, status);

      CREATE TABLE tag_runs (
        account INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        last_run_at INTEGER,
        last_message_time INTEGER,
        PRIMARY KEY (account, session_id)
      );
    `);
  },
};
