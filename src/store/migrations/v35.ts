import type { Migration } from './types.ts';

export const migration: Migration = {
  version: 35,
  up(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS inner_voice (
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        text TEXT NOT NULL CHECK (length(text) > 0),
        time INTEGER NOT NULL CHECK (time >= 0),
        PRIMARY KEY (session_id, message_id, ordinal),
        FOREIGN KEY (session_id, message_id)
          REFERENCES messages (session_id, message_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_inner_voice_time
        ON inner_voice (time DESC);
    `);
  },
};
