import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/store/db.ts';

function createDatabaseFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-store-'));
  return { root, databasePath: path.join(root, 'aquarium.db') };
}

test('openDatabase 开启 WAL 并创建 Aquarium 数据表与调试记录表', () => {
  const { root, databasePath } = createDatabaseFixture();
  let database: DatabaseSync | undefined;
  try {
    database = openDatabase(databasePath);
    const journal = database.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    const version = database.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number };
    const debugColumns = database.prepare("PRAGMA table_info('debug_traces')").all() as Array<{ name: string }>;

    assert.equal(journal.journal_mode.toLowerCase(), 'wal');
    assert.deepEqual(tables.map((table) => table.name), [
      'debug_traces',
      'decisions',
      'image_captions',
      'messages',
      'schema_version',
      'usage',
    ]);
    assert.deepEqual(debugColumns.map((column) => column.name), [
      'id', 'time', 'session_id', 'message_id', 'slot', 'provider', 'model',
      'prompt_json', 'response_text', 'prompt_hash', 'detail_json',
    ]);
    assert.equal(version.version, 2);
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

    assert.equal(version.version, 2);
    assert.ok(messageIndexes.some((index) => index.name === 'idx_messages_session_time'));
    const debugIndexes = second.prepare("PRAGMA index_list('debug_traces')").all() as Array<{ name: string }>;
    assert.ok(debugIndexes.some((index) => index.name === 'idx_debug_traces_session_time'));
  } finally {
    for (const database of databases) {
      if (database.isOpen) database.close();
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('版本 1 数据库会升级到包含 debug_traces 的版本 2', () => {
  const { root, databasePath } = createDatabaseFixture();
  let legacy: DatabaseSync | undefined;
  let upgraded: DatabaseSync | undefined;
  try {
    legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE schema_version (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL
      );
      INSERT INTO schema_version (id, version) VALUES (1, 1);
    `);
    legacy.close();
    legacy = undefined;

    upgraded = openDatabase(databasePath);
    const version = upgraded.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number };
    const table = upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'debug_traces'")
      .get() as { name: string } | undefined;

    assert.equal(version.version, 2);
    assert.equal(table?.name, 'debug_traces');
  } finally {
    if (legacy?.isOpen) legacy.close();
    if (upgraded?.isOpen) upgraded.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
