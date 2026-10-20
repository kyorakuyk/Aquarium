import type { Migration } from './types.ts';

export const migration: Migration = {
  version: 7,
  up(database) {
    database.exec(`
      CREATE TABLE persona_versions (
        id INTEGER PRIMARY KEY,
        persona_id TEXT NOT NULL,
        saved_at INTEGER NOT NULL,
        markdown TEXT NOT NULL,
        traits_json TEXT NOT NULL,
        note TEXT
      );
      CREATE INDEX idx_persona_versions_persona_saved_at
        ON persona_versions (persona_id, saved_at, id);
      ALTER TABLE mood_events ADD COLUMN valence_after REAL NULL;
      ALTER TABLE mood_events ADD COLUMN arousal_after REAL NULL;
    `);
  },
};
