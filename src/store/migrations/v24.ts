import type { Migration } from './types.ts';

export const migration: Migration = {
  version: 24,
  up(database) {
    const table = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tags'").get();
    if (!table) return;
    const columns = new Set((database.prepare("PRAGMA table_info('tags')").all() as Array<{ name: string }>)
      .map(({ name }) => name));
    if (!columns.has('certain')) {
      database.exec('ALTER TABLE tags ADD COLUMN certain INTEGER NOT NULL DEFAULT 0 CHECK (certain IN (0, 1));');
    }

    const isView = columns.has('kind') ? "kind = 'view'" : '0';
    const isManualSource = columns.has('source') ? "source = 'manual'" : '0';
    const isManualOrigin = columns.has('origin') ? "origin = 'manual'" : '0';
    const hasEnoughSamples = columns.has('samples') ? 'samples >= 3' : '0';
    database.exec(`
      UPDATE tags
      SET certain = CASE
        WHEN ${isView} AND (${isManualSource} OR ${isManualOrigin} OR ${hasEnoughSamples}) THEN 1
        ELSE 0
      END;
    `);
  },
};
