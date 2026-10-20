import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { migrations } from './migrations/index.ts';

export function openDatabase(databasePath = join(process.cwd(), 'data', 'aquarium.db')): DatabaseSync {
  if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  try {
    database.exec('PRAGMA journal_mode = WAL;');
    database.exec('PRAGMA foreign_keys = ON;');
    applyMigrations(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function applyMigrations(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL
    );
  `);
  database.prepare('INSERT OR IGNORE INTO schema_version (id, version) VALUES (1, 0)').run();

  const row = database.prepare('SELECT version FROM schema_version WHERE id = 1').get();
  const currentVersion = row?.version;
  if (typeof currentVersion !== 'number' || !Number.isSafeInteger(currentVersion) || currentVersion < 0) {
    throw new Error('数据库 schema_version 无效');
  }
  if (currentVersion > migrations.length) {
    throw new Error(`数据库版本 ${currentVersion} 高于当前支持版本 ${migrations.length}`);
  }

  for (const migration of migrations) {
    if (migration.version <= currentVersion) continue;
    database.exec('BEGIN IMMEDIATE;');
    try {
      migration.up(database);
      database.prepare('UPDATE schema_version SET version = ? WHERE id = 1').run(migration.version);
      database.exec('COMMIT;');
    } catch (error) {
      if (database.isTransaction) database.exec('ROLLBACK;');
      throw error;
    }
  }
}
