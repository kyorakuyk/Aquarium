import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../src/store/db.ts';
import { migrations } from '../src/store/migrations/index.ts';

test('migration versions start at one and are continuous and unique', () => {
  const versions = migrations.map(({ version }) => version);
  assert.deepEqual(versions, Array.from({ length: 17 }, (_, index) => index + 1));
  assert.equal(new Set(versions).size, versions.length);
  assert.ok(migrations.every(({ up }) => typeof up === 'function'));
});

test('v17 creates the session-scoped tag veto table and lookup index', () => {
  const database = openDatabase(':memory:');
  try {
    const version = database.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number };
    const columns = database.prepare("PRAGMA table_info('tag_vetoes')").all() as Array<{ name: string }>;
    const indexes = database.prepare("PRAGMA index_list('tag_vetoes')").all() as Array<{ name: string }>;

    assert.equal(version.version, 17);
    assert.deepEqual(columns.map(({ name }) => name), [
      'id', 'account', 'session_id', 'user_id', 'category', 'subject_norm', 'text_norm', 'created_at',
    ]);
    assert.ok(indexes.some(({ name }) => name === 'idx_tag_vetoes_scope_norm'));
  } finally {
    database.close();
  }
});
