import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/store/db.ts';
import { migrations } from '../src/store/migrations/index.ts';
import { createRepository } from '../src/store/repository.ts';

test('migration versions start at one and are continuous and unique', () => {
  const versions = migrations.map(({ version }) => version);
  assert.deepEqual(versions, Array.from({ length: 21 }, (_, index) => index + 1));
  assert.equal(new Set(versions).size, versions.length);
  assert.ok(migrations.every(({ up }) => typeof up === 'function'));
});

test('v17 tag veto table remains available at the current schema version', () => {
  const database = openDatabase(':memory:');
  try {
    const version = database.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number };
    const columns = database.prepare("PRAGMA table_info('tag_vetoes')").all() as Array<{ name: string }>;
    const indexes = database.prepare("PRAGMA index_list('tag_vetoes')").all() as Array<{ name: string }>;

    assert.equal(version.version, 21);
    assert.deepEqual(columns.map(({ name }) => name), [
      'id', 'account', 'session_id', 'user_id', 'category', 'subject_norm', 'text_norm', 'created_at',
    ]);
    assert.ok(indexes.some(({ name }) => name === 'idx_tag_vetoes_scope_norm'));
  } finally {
    database.close();
  }
});

test('v18 creates account- and group-scoped QQ profile caches', () => {
  const database = openDatabase(':memory:');
  try {
    const version = database.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number };
    const groupColumns = database.prepare("PRAGMA table_info('qq_group_profiles')")
      .all() as Array<{ name: string; pk: number }>;
    const memberColumns = database.prepare("PRAGMA table_info('qq_member_profiles')")
      .all() as Array<{ name: string; pk: number }>;

    assert.equal(version.version, 21);
    assert.deepEqual(groupColumns.map(({ name }) => name), ['account', 'group_id', 'json', 'fetched_at']);
    assert.deepEqual(groupColumns.map(({ pk }) => pk), [1, 2, 0, 0]);
    assert.deepEqual(memberColumns.map(({ name }) => name), [
      'account', 'group_id', 'user_id', 'json', 'fetched_at',
    ]);
    assert.deepEqual(memberColumns.map(({ pk }) => pk), [1, 2, 3, 0, 0]);
  } finally {
    database.close();
  }
});

test('v20 schedules only unlocked quoted member speech tags for reclassification', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-migration-v20-'));
  const databasePath = path.join(root, 'aquarium.db');
  let database: ReturnType<typeof openDatabase> | undefined;
  try {
    database = openDatabase(databasePath);
    const repository = createRepository(database);
    const insertSpeech = (
      userId: number,
      text: string,
      overrides: { locked?: boolean; status?: 'candidate' | 'confirmed' | 'rejected' | 'superseded' } = {},
    ) => repository.insertTag({
      account: 7,
      sessionId: '7:group:8',
      userId,
      text,
      norm: text,
      category: 'speech',
      subject: null,
      polarity: null,
      origin: 'inferred',
      locked: overrides.locked ?? false,
      status: overrides.status ?? 'confirmed',
      source: 'auto',
      samples: 1,
      evidence: [{ messageId: `speech-${userId}`, time: 10, quote: `原话：${text}` }],
      firstSeen: 10,
      lastSeen: 10,
      supersededBy: null,
      updatedAt: 10,
    });
    const supported = insertSpeech(42, '「要饭」');
    const supportedCurly = insertSpeech(46, '“开心”');
    const plain = insertSpeech(43, '短句');
    const locked = insertSpeech(44, '「锁定」', { locked: true });
    const superseded = insertSpeech(45, '「旧标签」', { status: 'superseded' });
    database.prepare('UPDATE tags SET needs_reclassification = 0').run();
    database.prepare('UPDATE schema_version SET version = 19 WHERE id = 1').run();
    database.close();
    database = undefined;

    database = openDatabase(databasePath);
    const version = database.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number };
    const markers = database.prepare('SELECT id, needs_reclassification FROM tags ORDER BY id').all() as Array<{
      id: number;
      needs_reclassification: number;
    }>;

    assert.equal(version.version, 21);
    assert.deepEqual(markers.map(({ id, needs_reclassification }) => ({ id, needs_reclassification })), [
      { id: supported, needs_reclassification: 1 },
      { id: supportedCurly, needs_reclassification: 1 },
      { id: plain, needs_reclassification: 0 },
      { id: locked, needs_reclassification: 0 },
      { id: superseded, needs_reclassification: 0 },
    ]);
  } finally {
    if (database?.isOpen) database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
