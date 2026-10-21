import type { Migration } from './types.ts';

export const migration: Migration = {
  version: 18,
  up(database) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS qq_group_profiles (
        account INTEGER NOT NULL,
        group_id INTEGER NOT NULL,
        json TEXT NOT NULL,
        fetched_at INTEGER NOT NULL,
        PRIMARY KEY (account, group_id)
      );
      CREATE TABLE IF NOT EXISTS qq_member_profiles (
        account INTEGER NOT NULL,
        group_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        json TEXT NOT NULL,
        fetched_at INTEGER NOT NULL,
        PRIMARY KEY (account, group_id, user_id)
      );
    `);
  },
};
