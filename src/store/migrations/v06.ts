import type { Migration } from './types.ts';

export const migration: Migration = {
  version: 6,
  up(database) {
    const usageTable = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'usage'").get();
    if (usageTable) database.exec('ALTER TABLE usage ADD COLUMN account INTEGER;');
  },
};
