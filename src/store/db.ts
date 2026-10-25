import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { migrations } from './migrations/index.ts';
import type { MigrationContext } from './migrations/types.ts';

export interface OpenDatabaseOptions {
  affinityStart?: number;
  affinityTiers?: MigrationContext['affinityTiers'];
}

export function openDatabase(
  databasePath = join(process.cwd(), 'data', 'aquarium.db'),
  options: OpenDatabaseOptions = {},
): DatabaseSync {
  if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });
  const affinityStart = options.affinityStart ?? 15;
  if (!Number.isFinite(affinityStart) || affinityStart < -100 || affinityStart > 100) {
    throw new RangeError('好感起点必须在 −100 到 100 之间');
  }
  const context: MigrationContext = {
    affinityStart,
    affinityTiers: options.affinityTiers ?? {
      positive: [15, 35, 60, 85],
      negative: [-85, -60, -35, -15],
    },
  };
  const database = new DatabaseSync(databasePath);
  try {
    database.exec('PRAGMA journal_mode = WAL;');
    database.exec('PRAGMA foreign_keys = ON;');
    applyMigrations(database, context);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function applyMigrations(database: DatabaseSync, context: MigrationContext): void {
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
  const latestVersion = migrations.at(-1)?.version ?? 0;
  if (currentVersion > latestVersion) {
    throw new Error(`数据库版本 ${currentVersion} 高于当前支持版本 ${latestVersion}`);
  }

  for (const migration of migrations) {
    if (migration.version <= currentVersion) continue;
    database.exec('BEGIN IMMEDIATE;');
    try {
      migration.up(database, context);
      database.prepare('UPDATE schema_version SET version = ? WHERE id = 1').run(migration.version);
      database.exec('COMMIT;');
    } catch (error) {
      if (database.isTransaction) database.exec('ROLLBACK;');
      throw error;
    }
  }
}
