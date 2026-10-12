import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/store/db.ts';

function createDatabaseFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-store-'));
  return { root, databasePath: path.join(root, 'aquarium.db') };
}

test('openDatabase 开启 WAL 并按序创建全部 M1 表', () => {
  const { root, databasePath } = createDatabaseFixture();
  let database: DatabaseSync | undefined;
  try {
    database = openDatabase(databasePath);
    const journal = database.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    const version = database.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number };

    assert.equal(journal.journal_mode.toLowerCase(), 'wal');
    assert.deepEqual(tables.map((table) => table.name), [
      'decisions',
      'image_captions',
      'messages',
      'schema_version',
      'usage',
    ]);
    assert.equal(version.version, 1);
  } finally {
    if (database?.isOpen) database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('重复打开数据库不会重复应用迁移', () => {
  const { root, databasePath } = createDatabaseFixture();
  const databases: DatabaseSync[] = [];
  try {
    const first = openDatabase(databasePath);
    databases.push(first);
    first.close();
    const second = openDatabase(databasePath);
    databases.push(second);

    const version = second.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number };
    const messageIndexes = second.prepare("PRAGMA index_list('messages')").all() as Array<{ name: string }>;

    assert.equal(version.version, 1);
    assert.ok(messageIndexes.some((index) => index.name === 'idx_messages_session_time'));
  } finally {
    for (const database of databases) {
      if (database.isOpen) database.close();
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
