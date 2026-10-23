import type { Migration } from './types.ts';

export const migration: Migration = {
  version: 30,
  up(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS interaction_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account INTEGER NOT NULL CHECK (account > 0),
        time INTEGER NOT NULL CHECK (time >= 0),
        session_id TEXT NOT NULL CHECK (length(session_id) BETWEEN 1 AND 512),
        message_id TEXT CHECK (message_id IS NULL OR length(message_id) BETWEEN 1 AND 512),
        action_kind TEXT NOT NULL CHECK (action_kind IN ('react', 'poke', 'recall', 'mute', 'essence')),
        target TEXT CHECK (target IS NULL OR length(target) BETWEEN 1 AND 512),
        details_json TEXT NOT NULL DEFAULT '{}' CHECK (length(details_json) BETWEEN 2 AND 2048),
        source TEXT NOT NULL CHECK (source IN ('rule', 'llm', 'owner_command')),
        verdict TEXT NOT NULL CHECK (verdict IN ('executed', 'dry_run', 'blocked', 'failed')),
        reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 128)
      );
      CREATE INDEX IF NOT EXISTS idx_interaction_log_message
      ON interaction_log (session_id, message_id, time DESC, id DESC)
      WHERE message_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_interaction_log_account_time
      ON interaction_log (account, time DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_interaction_log_session_action
      ON interaction_log (session_id, action_kind, time DESC, id DESC);
    `);
  },
};
