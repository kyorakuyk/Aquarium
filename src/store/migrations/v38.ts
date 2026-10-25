import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from './types.ts';

const legacyColumns = [
  'message_id', 'sender_id', 'sender_name', 'is_self', 'text', 'processed_cycle_key',
];
const eventMemoColumns = [
  'account', 'session_id', 'event_id', 'title', 'summary', 'participants_json',
  'start_msg', 'end_msg', 'level', 'created_at', 'diary_cycle',
];
const tailColumns = [
  'account', 'session_id', 'message_id', 'created_at', 'diary_cycle',
];

function tableColumns(database: DatabaseSync, table: string): Set<string> {
  return new Set((database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(({ name }) => name));
}

function hasTable(database: DatabaseSync, table: string): boolean {
  return Boolean(database.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get('table', table));
}

function addCursorMessageRowWatermark(database: DatabaseSync): void {
  if (!hasTable(database, 'memory_cursors')) return;
  const columns = tableColumns(database, 'memory_cursors');
  if (!['account', 'session_id', 'organized_until_message_time', 'open_segment_start']
    .every((column) => columns.has(column))) {
    throw new Error('memory_cursors 结构不完整');
  }
  if (!columns.has('organized_until_message_row_id')) {
    database.exec('ALTER TABLE memory_cursors ADD COLUMN organized_until_message_row_id INTEGER');
  }
  // 旧游标无法证明截止秒内哪些消息已处理，保留空水位让这些消息重试而不丢失。
}

function createEventMemoTable(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE persona_memos (
      id INTEGER PRIMARY KEY,
      account INTEGER NOT NULL CHECK (account > 0),
      session_id TEXT NOT NULL CHECK (length(session_id) BETWEEN 1 AND 512),
      event_id INTEGER,
      title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 16),
      summary TEXT NOT NULL CHECK (length(trim(summary)) BETWEEN 1 AND 120),
      participants_json TEXT NOT NULL DEFAULT '[]',
      start_msg TEXT NOT NULL CHECK (length(start_msg) BETWEEN 1 AND 512),
      end_msg TEXT NOT NULL CHECK (length(end_msg) BETWEEN 1 AND 512),
      level TEXT NOT NULL DEFAULT 'L0' CHECK (level IN ('L0', 'L1', 'L2')),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      diary_cycle TEXT,
      FOREIGN KEY (event_id, account) REFERENCES events (id, account) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX idx_persona_event_memos_event
      ON persona_memos (account, event_id) WHERE event_id IS NOT NULL;
    CREATE UNIQUE INDEX idx_persona_event_memos_source
      ON persona_memos (account, session_id, start_msg, end_msg, title, summary) WHERE event_id IS NULL;
    CREATE INDEX idx_persona_event_memos_account_created
      ON persona_memos (account, created_at DESC, id DESC);
    CREATE INDEX idx_persona_event_memos_diary
      ON persona_memos (account, diary_cycle, created_at, id);

    CREATE TABLE persona_memory_tails (
      account INTEGER NOT NULL CHECK (account > 0),
      session_id TEXT NOT NULL CHECK (length(session_id) BETWEEN 1 AND 512),
      message_id TEXT NOT NULL CHECK (length(message_id) BETWEEN 1 AND 512),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      diary_cycle TEXT,
      PRIMARY KEY (account, session_id, message_id)
    );
    CREATE INDEX idx_persona_memory_tails_account_time
      ON persona_memory_tails (account, created_at, session_id, message_id);
  `);
}

export const migration: Migration = {
  version: 38,
  up(database) {
    if (hasTable(database, 'persona_memos')) {
      const columns = tableColumns(database, 'persona_memos');
      const isLegacy = legacyColumns.every((column) => columns.has(column));
      const isEventMemo = eventMemoColumns.every((column) => columns.has(column));
      if (isLegacy && !hasTable(database, 'persona_memos_legacy_v26')) {
        database.exec('ALTER TABLE persona_memos RENAME TO persona_memos_legacy_v26');
      } else if (!isEventMemo) {
        throw new Error('persona_memos 结构既不是 v26 归档源，也不是 v38 目标结构');
      }
    }
    if (!hasTable(database, 'persona_memos')) createEventMemoTable(database);
    if (hasTable(database, 'persona_memory_tails')) {
      if (!tailColumns.every((column) => tableColumns(database, 'persona_memory_tails').has(column))) {
        throw new Error('persona_memory_tails 结构不完整');
      }
    } else {
      database.exec(`
        CREATE TABLE persona_memory_tails (
          account INTEGER NOT NULL CHECK (account > 0),
          session_id TEXT NOT NULL CHECK (length(session_id) BETWEEN 1 AND 512),
          message_id TEXT NOT NULL CHECK (length(message_id) BETWEEN 1 AND 512),
          created_at INTEGER NOT NULL CHECK (created_at >= 0),
          diary_cycle TEXT,
          PRIMARY KEY (account, session_id, message_id)
        );
        CREATE INDEX idx_persona_memory_tails_account_time
          ON persona_memory_tails (account, created_at, session_id, message_id);
      `);
    }
    database.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_persona_event_memos_event
        ON persona_memos (account, event_id) WHERE event_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_persona_event_memos_source
        ON persona_memos (account, session_id, start_msg, end_msg, title, summary) WHERE event_id IS NULL;
      CREATE INDEX IF NOT EXISTS idx_persona_event_memos_account_created
        ON persona_memos (account, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_persona_event_memos_diary
        ON persona_memos (account, diary_cycle, created_at, id);
      CREATE INDEX IF NOT EXISTS idx_persona_memory_tails_account_time
        ON persona_memory_tails (account, created_at, session_id, message_id);
    `);
    addCursorMessageRowWatermark(database);
  },
};
