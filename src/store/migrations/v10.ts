import type { Migration } from './types.ts';

export const migration: Migration = {
  version: 10,
  up(database) {
    const imageCaptions = database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'image_captions'",
    ).get();
    if (imageCaptions) {
      const columns = new Set((database.prepare("PRAGMA table_info('image_captions')").all() as Array<{ name: string }>)
        .map(({ name }) => name));
      const additions = [
        ['md5', 'TEXT'],
        ['kind', 'TEXT'],
        ['description', 'TEXT'],
        ['text', 'TEXT'],
        ['legible', 'INTEGER'],
        ['vision_model', 'TEXT'],
        ['vision_template_version', 'TEXT'],
      ] as const;
      for (const [name, definition] of additions) {
        if (!columns.has(name)) database.exec(`ALTER TABLE image_captions ADD COLUMN ${name} ${definition}`);
      }
    }

    const stickers = database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'stickers'",
    ).get();
    if (stickers) {
      const columns = new Set((database.prepare("PRAGMA table_info('stickers')").all() as Array<{ name: string }>)
        .map(({ name }) => name));
      if (!columns.has('manual_desc')) {
        database.exec("ALTER TABLE stickers ADD COLUMN manual_desc TEXT NOT NULL DEFAULT ''");
      }
    }
  },
};
