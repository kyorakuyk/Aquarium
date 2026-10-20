import type { Migration } from './types.ts';

export const migration: Migration = {
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
};
