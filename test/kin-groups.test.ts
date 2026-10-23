import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { registerKinGroupRoutes } from '../src/panel-server/kin-group-routes.ts';
import { openDatabase } from '../src/store/db.ts';
import { migrations } from '../src/store/migrations/index.ts';
import { migration as kinGroupMigration } from '../src/store/migrations/v25.ts';
import { createRepository } from '../src/store/repository.ts';

test('kin groups persist explicit account membership without inferring accounts', () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    const tables = database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('kin_groups', 'kin_group_members', 'kin_tag_states') ORDER BY name",
    ).all() as Array<{ name: string }>;
    const tagColumns = database.prepare("PRAGMA table_info('tags')").all() as Array<{ name: string }>;
    assert.deepEqual(tables.map(({ name }) => name), ['kin_group_members', 'kin_groups', 'kin_tag_states']);
    assert.ok(tagColumns.some(({ name }) => name === 'source_account'));
    assert.ok(tagColumns.some(({ name }) => name === 'source_fact_id'));

    const groupId = repository.createKinGroup('眷属');
    assert.equal(repository.setKinGroupMembers(groupId, [1001, 1002]), true);
    assert.deepEqual(repository.kinGroupAccounts(groupId), [1001, 1002]);
    assert.deepEqual(repository.kinGroupIdsForAccount(1003), []);
    assert.equal(repository.sameKinGroup(1001, 1002), true);
    assert.equal(repository.sameKinGroup(1001, 1003), false);
  } finally {
    database.close();
  }
});

test('kin group routes expose configured accounts, require explicit membership, and reject unknown accounts', async () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    const app = new Hono();
    registerKinGroupRoutes(app, {
      repository,
      accounts: () => [{ account: 1001, name: '账号一' }, { account: 1002, name: '账号二' }],
      now: () => 1_800_000_000_000,
    });

    const created = await app.request('/api/kin-groups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '夜航' }),
    });
    assert.equal(created.status, 201);
    const createdView = await created.json() as { id: number };

    const rejected = await app.request(`/api/kin-groups/${createdView.id}/members`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accounts: [1001, 9999] }),
    });
    assert.equal(rejected.status, 400);

    const saved = await app.request(`/api/kin-groups/${createdView.id}/members`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accounts: [1001, 1002] }),
    });
    assert.equal(saved.status, 200);
    const response = await app.request('/api/kin-groups');
    assert.deepEqual(await response.json(), {
      accounts: [{ account: 1001, name: '账号一' }, { account: 1002, name: '账号二' }],
      groups: [{ id: createdView.id, name: '夜航', accounts: [1001, 1002] }],
    });
  } finally {
    database.close();
  }
});

test('v24 to v25 preserves tags and scopes shared-tag hysteresis by account and session', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
      INSERT INTO schema_version (id, version) VALUES (1, 0);
    `);
    for (const migration of migrations.filter(({ version }) => version < kinGroupMigration.version)) {
      migration.up(database);
      database.prepare('UPDATE schema_version SET version = ? WHERE id = 1').run(migration.version);
    }
    const inserted = database.prepare(`
      INSERT INTO tags (
        account, session_id, user_id, text, norm, status, source, samples, evidence_json,
        first_seen, last_seen, updated_at, category, origin, locked, needs_reclassification,
        kind, in_prompt, certain
      ) VALUES (?, ?, NULL, ?, ?, 'confirmed', 'auto', 1, '[]', 1, 1, 1, 'recent', 'inferred', 0, 0, 'fact', 0, 0)
    `).run(9001, '9001:group:91', '旧群聊事实', '旧群聊事实');
    const legacyTagId = Number(inserted.lastInsertRowid);
    kinGroupMigration.up(database);
    database.prepare('UPDATE schema_version SET version = ? WHERE id = 1').run(kinGroupMigration.version);

    const stateTable = database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kin_tag_states'",
    ).get() as { name: string } | undefined;
    assert.equal(stateTable?.name, 'kin_tag_states');
    const legacyTag = database.prepare(
      'SELECT text, source_account, source_fact_id FROM tags WHERE id = ?',
    ).get(legacyTagId) as { text: string; source_account: number | null; source_fact_id: number | null };
    assert.deepEqual({ ...legacyTag }, { text: '旧群聊事实', source_account: null, source_fact_id: null });

    for (const migration of migrations.filter(({ version }) => version > kinGroupMigration.version)) {
      migration.up(database);
      database.prepare('UPDATE schema_version SET version = ? WHERE id = 1').run(migration.version);
    }

    const repository = createRepository(database);
    const first = repository.kinTagPromptState(9002, '9002:group:1', legacyTagId);
    const otherSession = repository.kinTagPromptState(9002, '9002:group:2', legacyTagId);
    const otherAccount = repository.kinTagPromptState(9003, '9003:group:1', legacyTagId);
    repository.updateKinTagPromptStateById(first.id, true);
    assert.equal(repository.kinTagPromptState(9002, '9002:group:1', legacyTagId).inPrompt, true);
    assert.equal(repository.kinTagPromptState(9002, '9002:group:2', legacyTagId).inPrompt, false);
    assert.equal(repository.kinTagPromptState(9003, '9003:group:1', legacyTagId).inPrompt, false);
    assert.equal(otherSession.inPrompt, false);
    assert.equal(otherAccount.inPrompt, false);
  } finally {
    database.close();
  }
});
