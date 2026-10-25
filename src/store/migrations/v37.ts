import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from './types.ts';

function hasTable(database: DatabaseSync, table: string): boolean {
  return Boolean(database.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', table));
}

function hasColumns(database: DatabaseSync, table: string, expected: readonly string[]): boolean {
  const columns = new Set((database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
    .map(({ name }) => name));
  return expected.every((column) => columns.has(column));
}

function backfillFromMessages(database: DatabaseSync): void {
  if (!hasTable(database, 'messages')) return;
  if (hasTable(database, 'persona_memos')
    && hasColumns(database, 'persona_memos', ['account', 'session_id', 'created_at', 'processed_cycle_key'])) {
    database.exec(`
      WITH sessions AS (
        SELECT DISTINCT
          CAST(substr(session_id, 1, instr(session_id, ':') - 1) AS INTEGER) AS account,
          session_id
        FROM messages
        WHERE instr(session_id, ':') > 1
          AND substr(session_id, 1, instr(session_id, ':') - 1) <> ''
          AND substr(session_id, 1, instr(session_id, ':') - 1) NOT GLOB '*[^0-9]*'
      ), organized AS (
        SELECT account, session_id, MAX(created_at) AS organized_until
        FROM persona_memos
        WHERE processed_cycle_key IS NOT NULL
        GROUP BY account, session_id
      )
      INSERT OR IGNORE INTO memory_cursors
        (account, session_id, organized_until_message_time, open_segment_start)
      SELECT sessions.account, sessions.session_id, organized.organized_until,
        (SELECT MIN(messages.time) FROM messages
          WHERE messages.session_id = sessions.session_id
            AND (organized.organized_until IS NULL OR messages.time > organized.organized_until))
      FROM sessions
      LEFT JOIN organized
        ON organized.account = sessions.account AND organized.session_id = sessions.session_id
    `);
    return;
  }
  database.exec(`
    INSERT OR IGNORE INTO memory_cursors
      (account, session_id, organized_until_message_time, open_segment_start)
    SELECT CAST(substr(session_id, 1, instr(session_id, ':') - 1) AS INTEGER), session_id, NULL, MIN(time)
    FROM messages
    WHERE instr(session_id, ':') > 1
      AND substr(session_id, 1, instr(session_id, ':') - 1) <> ''
      AND substr(session_id, 1, instr(session_id, ':') - 1) NOT GLOB '*[^0-9]*'
    GROUP BY session_id
  `);
}

export const migration: Migration = {
  version: 37,
  up(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS memory_cursors (
        account INTEGER NOT NULL CHECK (account > 0),
        session_id TEXT NOT NULL CHECK (length(session_id) > 0),
        organized_until_message_time INTEGER,
        open_segment_start INTEGER,
        PRIMARY KEY (account, session_id)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_cursors_account
        ON memory_cursors (account, session_id);
    `);
    backfillFromMessages(database);
  },
};
