import type { Migration } from './types.ts';

export const migration: Migration = {
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
};
