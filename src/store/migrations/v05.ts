import type { Migration } from './types.ts';

export const migration: Migration = {
  version: 5,
  up(database) {
    database.exec(`
      CREATE TABLE affinity_state (
        account INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        value REAL NOT NULL CHECK (value >= 0 AND value <= 100),
        level TEXT NOT NULL CHECK (level IN ('cold', 'cool', 'neutral', 'warm', 'close')),
        level_since INTEGER NOT NULL,
        last_level_change_at INTEGER NOT NULL,
        last_interaction_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (account, user_id)
      );

      CREATE TABLE affinity_events (
        id INTEGER PRIMARY KEY,
        account INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        time INTEGER NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('appraise', 'called', 'manual', 'band')),
        session_id TEXT,
        delta REAL NOT NULL,
        applied REAL NOT NULL,
        reason TEXT NOT NULL,
        level_before TEXT CHECK (level_before IS NULL OR level_before IN ('cold', 'cool', 'neutral', 'warm', 'close')),
        level_after TEXT CHECK (level_after IS NULL OR level_after IN ('cold', 'cool', 'neutral', 'warm', 'close'))
      );
      CREATE INDEX idx_affinity_events_account_user_time ON affinity_events (account, user_id, time);
    `);
  },
};
