import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { TagRecord } from '../src/store/affect-repo.ts';
import { openDatabase } from '../src/store/db.ts';
import { createRepository } from '../src/store/repository.ts';
import { CURRENT_SCHEMA_VERSION } from './schema-version.ts';

function tag(overrides: Partial<TagRecord> = {}): TagRecord {
  const base: TagRecord = {
    account: 7,
    sessionId: '7:group:8',
    userId: 42,
    text: '印象标签',
    norm: '印象标签',
    category: 'personality',
    subject: null,
    polarity: null,
    origin: 'inferred',
    locked: false,
    status: 'confirmed',
    source: 'auto',
    samples: 1,
    evidence: [{ messageId: 'seed', time: 10, quote: '证据' }],
    firstSeen: 10,
    lastSeen: 10,
    supersededBy: null,
    updatedAt: 10,
  };
  return { ...base, ...overrides };
}

function certain(repository: ReturnType<typeof createRepository>, id: number): boolean | undefined {
  return (repository.tagById(id) as unknown as { certain?: boolean } | undefined)?.certain;
}

test('view 标签确定性按 manual 与 samples >= 3 计算，事实标签不使用该标记', () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    const uncertainId = repository.insertTag(tag({ samples: 2 }));
    const confirmedBySamplesId = repository.insertTag(tag({ text: '三次印证', norm: '三次印证', samples: 3 }));
    const manualId = repository.insertTag(tag({
      text: '手动确认', norm: '手动确认', origin: 'manual', source: 'auto',
    }));
    const manualSourceId = repository.insertTag(tag({
      text: '手动来源', norm: '手动来源', origin: 'inferred', source: 'manual',
    }));
    const factId = repository.insertTag(tag({
      userId: null,
      text: '客观知识', norm: '客观知识', category: 'topic', origin: 'manual', source: 'manual',
    }));

    assert.equal(certain(repository, uncertainId), false);
    assert.equal(certain(repository, confirmedBySamplesId), true);
    assert.equal(certain(repository, manualId), true);
    assert.equal(certain(repository, manualSourceId), true);
    assert.equal(certain(repository, factId), false);

    repository.updateTag(uncertainId, { samples: 3 });
    assert.equal(certain(repository, uncertainId), true);
  } finally {
    database.close();
  }
});

test('v24 回填 view 标签确定性并保留标签行', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-migration-v24-'));
  const databasePath = path.join(root, 'aquarium.db');
  let database: ReturnType<typeof openDatabase> | undefined;
  try {
    database = openDatabase(databasePath);
    const repository = createRepository(database);
    repository.insertTag(tag({ text: '两次', norm: '两次', samples: 2 }));
    repository.insertTag(tag({ text: '三次', norm: '三次', samples: 3 }));
    repository.insertTag(tag({
      text: '手动', norm: '手动', origin: 'manual', source: 'auto', samples: 1,
    }));
    repository.insertTag(tag({
      text: '手动来源', norm: '手动来源', origin: 'inferred', source: 'manual', samples: 1,
    }));
    repository.insertTag(tag({
      userId: null, text: '知识', norm: '知识', category: 'topic', origin: 'manual', source: 'manual', samples: 3,
    }));
    const originalCount = database.prepare('SELECT COUNT(*) AS total FROM tags').get() as { total: number };
    const columns = new Set((database.prepare("PRAGMA table_info('tags')").all() as Array<{ name: string }>)
      .map(({ name }) => name));
    database.close();
    database = undefined;

    const legacy = new DatabaseSync(databasePath);
    try {
      if (columns.has('certain')) legacy.exec('ALTER TABLE tags DROP COLUMN certain;');
      legacy.prepare('UPDATE schema_version SET version = 23 WHERE id = 1').run();
    } finally {
      legacy.close();
    }

    database = openDatabase(databasePath);
    const version = database.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number };
    const tagColumns = database.prepare("PRAGMA table_info('tags')").all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const certainColumn = tagColumns.find(({ name }) => name === 'certain');
    assert.equal(version.version, CURRENT_SCHEMA_VERSION);
    assert.ok(certainColumn);
    const migrated = database.prepare('SELECT text, kind, certain FROM tags ORDER BY id').all() as Array<{
      text: string;
      kind: string;
      certain: number;
    }>;
    const countAfter = database.prepare('SELECT COUNT(*) AS total FROM tags').get() as { total: number };
    const impressionTable = database.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'persona_impressions'",
    ).get();

    assert.equal(certainColumn.type, 'INTEGER');
    assert.equal(certainColumn.notnull, 1);
    assert.equal(certainColumn.dflt_value, '0');
    assert.deepEqual(migrated.map(({ text, kind, certain }) => ({ text, kind, certain })), [
      { text: '两次', kind: 'view', certain: 0 },
      { text: '三次', kind: 'view', certain: 1 },
      { text: '手动', kind: 'view', certain: 1 },
      { text: '手动来源', kind: 'view', certain: 1 },
      { text: '知识', kind: 'fact', certain: 0 },
    ]);
    assert.equal(countAfter.total, originalCount.total);
    assert.equal(impressionTable, undefined);
    const tableSql = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tags'")
      .get() as { sql: string };
    assert.match(tableSql.sql, /certain IN \(0, 1\)/u);
  } finally {
    if (database?.isOpen) database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
