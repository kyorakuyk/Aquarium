import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import type { TagRecord } from '../src/store/affect-repo.ts';
import { openDatabase } from '../src/store/db.ts';
import { migrations } from '../src/store/migrations/index.ts';
import { createRepository } from '../src/store/repository.ts';

test('migration versions start at one and are continuous and unique', () => {
  const versions = migrations.map(({ version }) => version);
  assert.deepEqual(versions, Array.from({ length: versions.length }, (_, index) => index + 1));
  assert.equal(new Set(versions).size, versions.length);
  assert.ok(migrations.every(({ up }) => typeof up === 'function'));
});

test('v17 tag veto table remains available at the current schema version', () => {
  const database = openDatabase(':memory:');
  try {
    const version = database.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number };
    const columns = database.prepare("PRAGMA table_info('tag_vetoes')").all() as Array<{ name: string }>;
    const indexes = database.prepare("PRAGMA index_list('tag_vetoes')").all() as Array<{ name: string }>;

    assert.equal(version.version, migrations.at(-1)?.version);
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

    assert.equal(version.version, migrations.at(-1)?.version);
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

test('latest migration creates account-scoped event and annotation tables', () => {
  const database = openDatabase(':memory:');
  try {
    const version = database.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number };
    const eventColumns = database.prepare("PRAGMA table_info('events')").all() as Array<{ name: string }>;
    const noteColumns = database.prepare("PRAGMA table_info('event_notes')").all() as Array<{ name: string }>;
    const eventIndexes = database.prepare("PRAGMA index_list('events')").all() as Array<{ name: string }>;
    const noteForeignKeys = database.prepare("PRAGMA foreign_key_list('event_notes')").all() as Array<{
      table: string;
      from: string;
      to: string;
    }>;

    assert.equal(version.version, migrations.at(-1)?.version);
    assert.deepEqual(eventColumns.map(({ name }) => name), [
      'id', 'account', 'source_group_id', 'anchor_message_id', 'title', 'summary',
      'participant_ids_json', 'evidence_message_ids_json', 'occurred_at', 'created_at', 'updated_at',
    ]);
    assert.deepEqual(noteColumns.map(({ name }) => name), [
      'id', 'account', 'event_id', 'owner_id', 'source_session_id', 'text', 'intent', 'level', 'status',
      'source_message_ids_json', 'created_at', 'updated_at',
    ]);
    assert.ok(eventIndexes.some(({ name }) => name === 'idx_events_account_group_time'));
    assert.ok(noteForeignKeys.some(({ table, from, to }) => table === 'events' && from === 'event_id' && to === 'id'));
    assert.ok(noteForeignKeys.some(({ table, from, to }) => table === 'events' && from === 'account' && to === 'account'));

    const eventId = Number(database.prepare(`
      INSERT INTO events (
        account, source_group_id, anchor_message_id, title, summary, participant_ids_json,
        evidence_message_ids_json, occurred_at, created_at, updated_at
      ) VALUES (7, 8, 'event-source', '周末漫展', '群友约好周末参加漫展', '[42]', '["event-source"]', 10, 10, 10)
    `).run().lastInsertRowid);
    const insertNote = database.prepare(`
      INSERT INTO event_notes (
        account, event_id, owner_id, source_session_id, text, source_message_ids_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertNote.run(7, eventId, 42, '7:private:42', '事件私聊注解', '["note-source"]', 10, 10);
    assert.throws(() => insertNote.run(
      8, eventId, 43, '8:private:43', '跨账号错误注解', '["other-source"]', 10, 10,
    ));
  } finally {
    database.close();
  }
});

test('reapplying the latest event advocacy migration preserves existing group messages', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-event-migration-'));
  const databasePath = path.join(root, 'aquarium.db');
  let database: ReturnType<typeof openDatabase> | undefined;
  try {
    database = openDatabase(databasePath);
    const repository = createRepository(database);
    repository.saveMessage({
      sessionId: '7:group:8',
      messageId: 'before-event-migration',
      senderId: 42,
      senderName: '小明',
      isSelf: false,
      plainText: '既有群聊消息',
      segments: [],
      time: 10,
    });
    const latestVersion = migrations.at(-1)?.version ?? 0;
    database.exec('DROP TABLE event_advocacies;');
    database.prepare('UPDATE schema_version SET version = ? WHERE id = 1').run(latestVersion - 1);
    database.close();
    database = undefined;

    database = openDatabase(databasePath);
    const version = database.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number };
    const rows = database.prepare('SELECT message_id, plain_text FROM messages').all() as Array<{
      message_id: string;
      plain_text: string;
    }>;

    assert.equal(version.version, latestVersion);
    assert.deepEqual(rows.map(({ message_id, plain_text }) => ({ message_id, plain_text })), [
      { message_id: 'before-event-migration', plain_text: '既有群聊消息' },
    ]);
  } finally {
    if (database?.isOpen) database.close();
    fs.rmSync(root, { recursive: true, force: true });
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

    assert.equal(version.version, migrations.at(-1)?.version);
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

test('v22 将旧标签回填为 kind 并完整保留原标签', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-migration-v22-'));
  const databasePath = path.join(root, 'aquarium.db');
  let database: ReturnType<typeof openDatabase> | undefined;
  try {
    database = openDatabase(databasePath);
    const repository = createRepository(database);
    const memberCategories = new Set<TagRecord['category']>([
      'identity', 'personality', 'fandom', 'speech', 'catchphrase', 'social', 'dislike',
    ]);
    const addTag = (
      category: TagRecord['category'],
      text: string,
      overrides: {
        polarity?: TagRecord['polarity'];
        origin?: TagRecord['origin'];
        locked?: boolean;
        status?: TagRecord['status'];
        source?: TagRecord['source'];
        samples?: number;
        evidence?: TagRecord['evidence'];
      } = {},
    ) => repository.insertTag({
      account: 7,
      sessionId: '7:group:8',
      userId: memberCategories.has(category) ? 42 : null,
      text,
      norm: text,
      category,
      subject: null,
      polarity: overrides.polarity ?? null,
      origin: overrides.origin ?? 'inferred',
      locked: overrides.locked ?? false,
      status: overrides.status ?? 'confirmed',
      source: overrides.source ?? 'auto',
      samples: overrides.samples ?? 1,
      evidence: overrides.evidence ?? [{ messageId: text, time: 10, quote: `证据 ${text}` }],
      firstSeen: 10,
      lastSeen: 20,
      supersededBy: null,
      updatedAt: 20,
    });
    const expectedKinds = new Map<string, 'fact' | 'view'>();
    const categoryCases: Array<[TagRecord['category'], 'fact' | 'view']> = [
      ['positioning', 'fact'], ['topic', 'fact'], ['norms', 'fact'], ['meme', 'fact'],
      ['recent', 'fact'], ['schedule', 'fact'], ['identity', 'fact'], ['fandom', 'fact'],
      ['catchphrase', 'fact'], ['atmosphere', 'view'], ['personality', 'view'], ['speech', 'view'],
      ['social', 'view'], ['dislike', 'view'], ['misc', 'view'],
    ];
    for (const [category, kind] of categoryCases) {
      const text = `legacy-${category}`;
      addTag(category, text);
      expectedKinds.set(text, kind);
    }
    const polarityText = 'legacy-polarity-override';
    addTag('identity', polarityText, { polarity: 'like' });
    expectedKinds.set(polarityText, 'view');
    const manualText = 'legacy-manual-locked';
    addTag('misc', manualText, { origin: 'manual', source: 'manual', locked: true, samples: 4 });
    expectedKinds.set(manualText, 'view');
    const originalRows = database.prepare(`
      SELECT id, account, session_id, user_id, text, norm, category, subject, polarity, origin, locked,
        status, source, samples, evidence_json, first_seen, last_seen, superseded_by, updated_at
      FROM tags ORDER BY id
    `).all();
    const originalCount = originalRows.length;
    const currentColumns = new Set((database.prepare("PRAGMA table_info('tags')").all() as Array<{ name: string }>)
      .map(({ name }) => name));
    database.close();
    database = undefined;

    if (currentColumns.has('kind')) {
      const legacy = new DatabaseSync(databasePath);
      try {
        if (currentColumns.has('in_prompt')) legacy.exec('ALTER TABLE tags DROP COLUMN in_prompt;');
        legacy.exec('ALTER TABLE tags DROP COLUMN kind;');
        legacy.prepare('UPDATE schema_version SET version = 21 WHERE id = 1').run();
      } finally {
        legacy.close();
      }
    }

    database = openDatabase(databasePath);
    const version = database.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number };
    const columns = new Set((database.prepare("PRAGMA table_info('tags')").all() as Array<{ name: string }>)
      .map(({ name }) => name));
    assert.ok(columns.has('kind'));
    assert.equal(version.version, migrations.at(-1)?.version);
    const migratedRows = database.prepare('SELECT text, kind FROM tags ORDER BY id').all() as Array<{
      text: string;
      kind: string;
    }>;
    assert.equal(migratedRows.length, originalCount);
    for (const row of migratedRows) assert.equal(row.kind, expectedKinds.get(row.text), row.text);
    const preservedRows = database.prepare(`
      SELECT id, account, session_id, user_id, text, norm, category, subject, polarity, origin, locked,
        status, source, samples, evidence_json, first_seen, last_seen, superseded_by, updated_at
      FROM tags ORDER BY id
    `).all();
    assert.deepEqual(preservedRows, originalRows);
  } finally {
    if (database?.isOpen) database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('v23 adds in_prompt with a false default and preserves v22 tags', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-migration-v23-'));
  const databasePath = path.join(root, 'aquarium.db');
  let database: ReturnType<typeof openDatabase> | undefined;
  try {
    database = openDatabase(databasePath);
    const repository = createRepository(database);
    repository.insertTag({
      account: 7,
      sessionId: '7:group:8',
      userId: null,
      text: '迁移后仍保留',
      norm: '迁移后仍保留',
      category: 'positioning',
      subject: null,
      polarity: null,
      origin: 'manual',
      locked: true,
      status: 'confirmed',
      source: 'manual',
      samples: 3,
      evidence: [{ messageId: 'kept', time: 10, quote: '原始证据' }],
      firstSeen: 10,
      lastSeen: 20,
      supersededBy: null,
      updatedAt: 20,
    });
    const originalRows = database.prepare(`
      SELECT id, account, session_id, user_id, text, norm, category, kind, subject, polarity, origin, locked,
        status, source, samples, evidence_json, first_seen, last_seen, superseded_by, updated_at
      FROM tags ORDER BY id
    `).all();
    const currentColumns = new Set((database.prepare("PRAGMA table_info('tags')").all() as Array<{ name: string }>)
      .map(({ name }) => name));
    database.close();
    database = undefined;

    const legacy = new DatabaseSync(databasePath);
    try {
      if (currentColumns.has('in_prompt')) legacy.exec('ALTER TABLE tags DROP COLUMN in_prompt;');
      legacy.prepare('UPDATE schema_version SET version = 22 WHERE id = 1').run();
    } finally {
      legacy.close();
    }

    database = openDatabase(databasePath);
    const version = database.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number };
    const columns = new Set((database.prepare("PRAGMA table_info('tags')").all() as Array<{ name: string }>)
      .map(({ name }) => name));
    assert.ok(columns.has('in_prompt'));
    assert.equal(version.version, migrations.at(-1)?.version);
    const states = database.prepare('SELECT in_prompt FROM tags').all() as Array<{ in_prompt: number }>;
    assert.deepEqual(states.map(({ in_prompt }) => ({ in_prompt })), [{ in_prompt: 0 }]);
    const migratedRows = database.prepare(`
      SELECT id, account, session_id, user_id, text, norm, category, kind, subject, polarity, origin, locked,
        status, source, samples, evidence_json, first_seen, last_seen, superseded_by, updated_at
      FROM tags ORDER BY id
    `).all();
    assert.deepEqual(migratedRows, originalRows);
  } finally {
    if (database?.isOpen) database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
