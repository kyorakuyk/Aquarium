import type { Migration } from './types.ts';

export const migration: Migration = {
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
};
