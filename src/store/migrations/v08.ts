import type { Migration } from './types.ts';

export const migration: Migration = {
  version: 8,
  up(database) {
    database.exec(`
      CREATE TABLE stickers (
        id INTEGER PRIMARY KEY,
        account INTEGER NOT NULL,
        emoji_id TEXT NOT NULL,
        md5 TEXT NOT NULL,
        file TEXT,
        desc_qq TEXT NOT NULL DEFAULT '',
        desc_ai TEXT NOT NULL DEFAULT '',
        tags_json TEXT NOT NULL DEFAULT '[]',
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        missing INTEGER NOT NULL DEFAULT 0 CHECK (missing IN (0, 1)),
        use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
        last_used_at INTEGER,
        description_attempts INTEGER NOT NULL DEFAULT 0 CHECK (description_attempts BETWEEN 0 AND 3),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (account, md5)
      );
      CREATE INDEX idx_stickers_account_enabled ON stickers (account, enabled, missing);
    `);
  },
};
