import type { Migration } from './types.ts';

export const migration: Migration = {
  version: 25,
  up(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS kin_groups (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(trim(name)) BETWEEN 1 AND 40)
      );
      CREATE TABLE IF NOT EXISTS kin_group_members (
        group_id INTEGER NOT NULL REFERENCES kin_groups(id) ON DELETE CASCADE,
        account INTEGER NOT NULL CHECK (account > 0),
        PRIMARY KEY (group_id, account)
      );
      CREATE INDEX IF NOT EXISTS idx_kin_group_members_account ON kin_group_members (account, group_id);
    `);

    const tagsTable = database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tags'",
    ).get();
    if (!tagsTable) return;
    const columns = new Set((database.prepare("PRAGMA table_info('tags')").all() as Array<{ name: string }>)
      .map(({ name }) => name));
    if (!columns.has('source_account')) {
      database.exec('ALTER TABLE tags ADD COLUMN source_account INTEGER;');
      columns.add('source_account');
    }
    if (!columns.has('source_fact_id')) {
      database.exec('ALTER TABLE tags ADD COLUMN source_fact_id INTEGER;');
      columns.add('source_fact_id');
    }
    if (columns.has('account')) {
      database.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_relay_source_fact
        ON tags (account, source_fact_id) WHERE source_fact_id IS NOT NULL;
      `);
    }
    if (columns.has('id')) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS kin_tag_states (
          id INTEGER PRIMARY KEY,
          account INTEGER NOT NULL CHECK (account > 0),
          session_id TEXT NOT NULL CHECK (length(session_id) > 0),
          tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
          in_prompt INTEGER NOT NULL DEFAULT 0 CHECK (in_prompt IN (0, 1)),
          UNIQUE (account, session_id, tag_id)
        );
        CREATE INDEX IF NOT EXISTS idx_kin_tag_states_account_session
        ON kin_tag_states (account, session_id);
      `);
    }
  },
};
