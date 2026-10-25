import type { Migration } from './types.ts';

export const migration: Migration = {
  version: 33,
  up(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS persona_counterpart_bindings (
        account INTEGER NOT NULL,
        persona_id TEXT NOT NULL,
        counterpart_name TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL CHECK (created_at >= 0),
        PRIMARY KEY (account, persona_id, counterpart_name, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_persona_counterpart_bindings_user
        ON persona_counterpart_bindings (account, user_id, persona_id);

      CREATE TABLE IF NOT EXISTS persona_counterpart_claims (
        account INTEGER NOT NULL,
        persona_id TEXT NOT NULL,
        counterpart_name TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        evidence TEXT NOT NULL,
        first_seen INTEGER NOT NULL CHECK (first_seen >= 0),
        last_seen INTEGER NOT NULL CHECK (last_seen >= first_seen),
        status TEXT NOT NULL CHECK (status IN ('pending', 'dismissed')),
        PRIMARY KEY (account, persona_id, counterpart_name, user_id)
      );
      CREATE INDEX IF NOT EXISTS idx_persona_counterpart_claims_pending
        ON persona_counterpart_claims (account, persona_id, status, last_seen DESC);
    `);
  },
};
