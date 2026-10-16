import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

interface Migration {
  version: number;
  up(database: DatabaseSync): void;
}

const migrations: Migration[] = [
  {
    version: 1,
    up(database) {
      database.exec(`
        CREATE TABLE messages (
          id INTEGER PRIMARY KEY,
          session_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          sender_id INTEGER NOT NULL,
          sender_name TEXT NOT NULL,
          is_self INTEGER NOT NULL CHECK (is_self IN (0, 1)),
          plain_text TEXT NOT NULL,
          segments_json TEXT NOT NULL,
          time INTEGER NOT NULL,
          UNIQUE (session_id, message_id)
        );
        CREATE INDEX idx_messages_session_time ON messages (session_id, time);

        CREATE TABLE usage (
          id INTEGER PRIMARY KEY,
          time INTEGER NOT NULL,
          slot TEXT NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          input_tokens INTEGER NOT NULL,
          cached_tokens INTEGER NOT NULL,
          output_tokens INTEGER NOT NULL,
          cost_cny REAL NOT NULL,
          latency_ms INTEGER NOT NULL,
          ok INTEGER NOT NULL CHECK (ok IN (0, 1))
        );

        CREATE TABLE image_captions (
          key TEXT PRIMARY KEY,
          caption TEXT NOT NULL,
          time INTEGER NOT NULL
        );

        CREATE TABLE decisions (
          id INTEGER PRIMARY KEY,
          time INTEGER NOT NULL,
          session_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          replied INTEGER NOT NULL CHECK (replied IN (0, 1)),
          reason TEXT NOT NULL,
          detail_json TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 2,
    up(database) {
      database.exec(`
        CREATE TABLE debug_traces (
          id INTEGER PRIMARY KEY,
          time INTEGER NOT NULL,
          session_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          slot TEXT NOT NULL,
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          prompt_json TEXT NOT NULL,
          response_text TEXT NOT NULL,
          prompt_hash TEXT NOT NULL,
          detail_json TEXT NOT NULL
        );
        CREATE INDEX idx_debug_traces_session_time ON debug_traces (session_id, time);
      `);
    },
  },
  {
    version: 3,
    up(database) {
      database.exec(`
        CREATE TABLE pipeline_traces (
          id INTEGER PRIMARY KEY,
          time INTEGER NOT NULL,
          session_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          trace_json TEXT NOT NULL,
          UNIQUE (session_id, message_id)
        );
        CREATE INDEX idx_pipeline_traces_time ON pipeline_traces (time);
      `);
    },
  },
  {
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
  },
];

export function openDatabase(databasePath = join(process.cwd(), 'data', 'aquarium.db')): DatabaseSync {
  if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  try {
    database.exec('PRAGMA journal_mode = WAL;');
    database.exec('PRAGMA foreign_keys = ON;');
    applyMigrations(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function applyMigrations(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL
    );
  `);
  database.prepare('INSERT OR IGNORE INTO schema_version (id, version) VALUES (1, 0)').run();

  const row = database.prepare('SELECT version FROM schema_version WHERE id = 1').get();
  const currentVersion = row?.version;
  if (typeof currentVersion !== 'number' || !Number.isSafeInteger(currentVersion) || currentVersion < 0) {
    throw new Error('数据库 schema_version 无效');
  }
  if (currentVersion > migrations.length) {
    throw new Error(`数据库版本 ${currentVersion} 高于当前支持版本 ${migrations.length}`);
  }

  for (const migration of migrations) {
    if (migration.version <= currentVersion) continue;
    database.exec('BEGIN IMMEDIATE;');
    try {
      migration.up(database);
      database.prepare('UPDATE schema_version SET version = ? WHERE id = 1').run(migration.version);
      database.exec('COMMIT;');
    } catch (error) {
      if (database.isTransaction) database.exec('ROLLBACK;');
      throw error;
    }
  }
}
