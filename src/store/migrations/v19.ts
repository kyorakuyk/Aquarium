import type { DatabaseSync } from 'node:sqlite';

export const migrationV19 = {
  version: 19,
  up(database: DatabaseSync): void {
    database.exec(`
      CREATE TABLE IF NOT EXISTS account_kinds (
        account INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('human', 'bot', 'alt', 'owner')),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (account, user_id)
      );
      CREATE TABLE IF NOT EXISTS relations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account INTEGER NOT NULL,
        a_user_id INTEGER NOT NULL CHECK (a_user_id > 0),
        b_user_id INTEGER NOT NULL CHECK (b_user_id > 0),
        type TEXT NOT NULL CHECK (type IN ('alt', 'lover', 'brother', 'sister', 'roommate', 'enemy', 'other')),
        label TEXT,
        locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
        created_at INTEGER NOT NULL,
        CHECK (a_user_id != b_user_id),
        UNIQUE (account, a_user_id, b_user_id, type)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_relations_alt_account_b
        ON relations (account, b_user_id) WHERE type = 'alt';
      CREATE INDEX IF NOT EXISTS idx_relations_account_a
        ON relations (account, a_user_id);
      CREATE INDEX IF NOT EXISTS idx_relations_account_b
        ON relations (account, b_user_id);
    `);
  },
};
