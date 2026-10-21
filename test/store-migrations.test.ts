import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../src/store/db.ts';
import { migrations } from '../src/store/migrations/index.ts';

test('migration versions start at one and are continuous and unique', () => {
  const versions = migrations.map(({ version }) => version);
  assert.deepEqual(versions, Array.from({ length: 18 }, (_, index) => index + 1));
  assert.equal(new Set(versions).size, versions.length);
  assert.ok(migrations.every(({ up }) => typeof up === 'function'));
});

test('v17 tag veto table remains available at the current schema version', () => {
  const database = openDatabase(':memory:');
  try {
    const version = database.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number };
    const columns = database.prepare("PRAGMA table_info('tag_vetoes')").all() as Array<{ name: string }>;
    const indexes = database.prepare("PRAGMA index_list('tag_vetoes')").all() as Array<{ name: string }>;

    assert.equal(version.version, 18);
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

    assert.equal(version.version, 18);
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
