import type { Migration } from './types.ts';

export const migration: Migration = {
  version: 9,
  up(database) {
    const decisionsTable = database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'decisions'",
    ).get();
    if (decisionsTable) {
      database.exec(`
        CREATE INDEX IF NOT EXISTS idx_decisions_session_time
        ON decisions (session_id, time, id)
      `);
    }
  },
};
