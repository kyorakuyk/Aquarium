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

test('openDatabase 开启 WAL 并创建版本 23 数据表', () => {
  const { root, databasePath } = createDatabaseFixture();
  let database: DatabaseSync | undefined;
  try {
    database = openDatabase(databasePath);
    database.prepare(`
      INSERT INTO messages (session_id, message_id, sender_id, sender_name, is_self, plain_text, segments_json, time)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('900000001:group:123456', 'migration-preserve', 42, '群友', 0, '保留', '[]', 123);
    database.exec('DROP TABLE stickers; DROP TABLE private_facts; DROP TABLE privacy_runs; UPDATE schema_version SET version = 7 WHERE id = 1;');
    database.close();
    database = openDatabase(databasePath);
    const journal = database.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    const version = database.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number };
    const debugColumns = database.prepare("PRAGMA table_info('debug_traces')").all() as Array<{ name: string }>;
    const retained = database.prepare('SELECT plain_text FROM messages WHERE message_id = ?').get('migration-preserve') as { plain_text: string };

    assert.equal(journal.journal_mode.toLowerCase(), 'wal');
    assert.equal(retained.plain_text, '保留');
    assert.deepEqual(tables.map((table) => table.name), [
      'account_kinds',
      'activity_suggestion_dismissals',
      'affinity_events',
      'affinity_state',
      'debug_traces',
      'decisions',
      'group_summaries',
      'image_captions',
      'member_summaries',
      'messages',
      'mood_events',
      'mood_state',
      'persona_versions',
      'pipeline_traces',
      'privacy_runs',
      'private_facts',
      'profile_migrations',
      'qq_group_profiles',
      'qq_member_profiles',
      'relations',
      'schema_version',
      'stickers',
      'tag_drop_events',
      'tag_runs',
      'tag_subjects',
      'tag_vetoes',
      'tags',
      'usage',
    ]);
    assert.deepEqual(debugColumns.map((column) => column.name), [
      'id', 'time', 'session_id', 'message_id', 'slot', 'provider', 'model',
      'prompt_json', 'response_text', 'prompt_hash', 'detail_json',
    ]);
    assert.equal(version.version, 23);
  } finally {
    if (database?.isOpen) database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('openDatabase 创建版本 23 的情绪、好感度、标签、人设版本与表情库表', () => {
  const { root, databasePath } = createDatabaseFixture();
  let database: DatabaseSync | undefined;
  try {
    database = openDatabase(databasePath);
    const version = database.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number };
    const columns = database.prepare("PRAGMA table_info('pipeline_traces')").all() as Array<{ name: string }>;
    const indexes = database.prepare("PRAGMA index_list('pipeline_traces')").all() as Array<{ name: string }>;
    const stickerColumns = database.prepare("PRAGMA table_info('stickers')").all() as Array<{ name: string }>;
    const stickerIndexes = database.prepare("PRAGMA index_list('stickers')").all() as Array<{ unique: number }>;

    assert.equal(version.version, 23);
    assert.deepEqual(columns.map((column) => column.name), [
      'id', 'time', 'session_id', 'message_id', 'trace_json',
    ]);
    assert.ok(indexes.some((index) => index.name === 'idx_pipeline_traces_time'));
    assert.deepEqual(stickerColumns.map((column) => column.name), [
      'id', 'account', 'emoji_id', 'md5', 'file', 'desc_qq', 'desc_ai', 'tags_json',
      'enabled', 'missing', 'use_count', 'last_used_at', 'description_attempts', 'created_at', 'updated_at', 'manual_desc',
    ]);
    assert.ok(stickerIndexes.some((index) => index.unique === 1));

    const moodColumns = database.prepare("PRAGMA table_info('mood_state')").all() as Array<{ name: string }>;
    const eventColumns = database.prepare("PRAGMA table_info('mood_events')").all() as Array<{ name: string }>;
    const tagColumns = database.prepare("PRAGMA table_info('tags')").all() as Array<{ name: string }>;
    const runColumns = database.prepare("PRAGMA table_info('tag_runs')").all() as Array<{ name: string }>;
    const affinityColumns = database.prepare("PRAGMA table_info('affinity_state')").all() as Array<{ name: string }>;
    const affinityEventColumns = database.prepare("PRAGMA table_info('affinity_events')").all() as Array<{ name: string }>;
    const moodIndexes = database.prepare("PRAGMA index_list('mood_events')").all() as Array<{ name: string }>;
    const tagIndexes = database.prepare("PRAGMA index_list('tags')").all() as Array<{ name: string }>;
    const affinityIndexes = database.prepare("PRAGMA index_list('affinity_events')").all() as Array<{ name: string }>;

    assert.deepEqual(moodColumns.map((column) => column.name), [
      'account', 'valence', 'arousal', 'updated_at', 'band', 'band_since', 'last_band_change_at',
    ]);
    assert.deepEqual(eventColumns.map((column) => column.name), [
      'id', 'account', 'time', 'source', 'session_id', 'sender_id', 'dv', 'da',
      'applied_dv', 'applied_da', 'reason', 'band_before', 'band_after', 'valence_after', 'arousal_after',
    ]);
    const personaVersionColumns = database.prepare("PRAGMA table_info('persona_versions')").all() as Array<{ name: string; notnull: number }>;
    const personaVersionIndexes = database.prepare("PRAGMA index_list('persona_versions')").all() as Array<{ name: string }>;
    assert.deepEqual(personaVersionColumns.map((column) => column.name), [
      'id', 'persona_id', 'saved_at', 'markdown', 'traits_json', 'note',
    ]);
    assert.equal(personaVersionColumns.find((column) => column.name === 'note')?.notnull, 0);
    assert.ok(personaVersionIndexes.some((index) => index.name === 'idx_persona_versions_persona_saved_at'));
    assert.deepEqual(tagColumns.map((column) => column.name), [
      'id', 'account', 'session_id', 'user_id', 'text', 'norm', 'status', 'source',
      'samples', 'evidence_json', 'first_seen', 'last_seen', 'superseded_by', 'updated_at',
      'category', 'subject', 'polarity', 'origin', 'locked', 'needs_reclassification', 'kind', 'in_prompt',
    ]);
    assert.deepEqual(runColumns.map((column) => column.name), [
      'account', 'session_id', 'last_run_at', 'last_message_time',
    ]);
    assert.deepEqual(affinityColumns.map((column) => column.name), [
      'account', 'user_id', 'value', 'level', 'level_since', 'last_level_change_at', 'last_interaction_at', 'updated_at',
    ]);
    assert.deepEqual(affinityEventColumns.map((column) => column.name), [
      'id', 'account', 'user_id', 'time', 'source', 'session_id', 'delta', 'applied', 'reason', 'level_before', 'level_after',
    ]);
    assert.ok(moodIndexes.some((index) => index.name === 'idx_mood_events_account_time'));
    assert.ok(tagIndexes.some((index) => index.name === 'idx_tags_subject'));
    assert.ok(affinityIndexes.some((index) => index.name === 'idx_affinity_events_account_user_time'));
  } finally {
    if (database?.isOpen) database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('版本 8 数据库为表情频控增加决策时间索引并保留历史', () => {
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
      INSERT INTO schema_version (id, version) VALUES (1, 8);
      CREATE TABLE decisions (
        id INTEGER PRIMARY KEY,
        time INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        replied INTEGER NOT NULL,
        reason TEXT NOT NULL,
        detail_json TEXT NOT NULL
      );
      INSERT INTO decisions VALUES (1, 123, 'session', 'message', 1, 'replied', '{"kept":true}');
    `);
    legacy.close();
    legacy = undefined;

    upgraded = openDatabase(databasePath);
    const version = upgraded.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number };
    const indexes = upgraded.prepare("PRAGMA index_list('decisions')").all() as Array<{ name: string }>;
    const retained = upgraded.prepare('SELECT detail_json FROM decisions WHERE id = 1').get() as { detail_json: string };

    assert.equal(version.version, 23);
    assert.ok(indexes.some((index) => index.name === 'idx_decisions_session_time'));
    assert.equal(retained.detail_json, '{"kept":true}');
  } finally {
    if (legacy?.isOpen) legacy.close();
    if (upgraded?.isOpen) upgraded.close();
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

    assert.equal(version.version, 23);
    assert.ok(messageIndexes.some((index) => index.name === 'idx_messages_session_time'));
    const debugIndexes = second.prepare("PRAGMA index_list('debug_traces')").all() as Array<{ name: string }>;
    assert.ok(debugIndexes.some((index) => index.name === 'idx_debug_traces_session_time'));
    const pipelineIndexes = second.prepare("PRAGMA index_list('pipeline_traces')").all() as Array<{ name: string }>;
    assert.ok(pipelineIndexes.some((index) => index.name === 'idx_pipeline_traces_time'));
  } finally {
    for (const database of databases) {
      if (database.isOpen) database.close();
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('版本12迁移新增画像分类完成标记并保留旧标签', () => {
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
      INSERT INTO schema_version (id, version) VALUES (1, 12);
      CREATE TABLE tags (id INTEGER PRIMARY KEY, text TEXT NOT NULL);
      INSERT INTO tags VALUES (4, '保留标签');
    `);
    legacy.close();
    legacy = undefined;

    upgraded = openDatabase(databasePath);
    const version = upgraded.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number };
    const markerTable = upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'profile_migrations'").get();
    const preserved = upgraded.prepare('SELECT text FROM tags WHERE id = 4').get() as { text: string };

    assert.equal(version.version, 23);
    assert.ok(markerTable);
    assert.equal(preserved.text, '保留标签');
  } finally {
    if (legacy?.isOpen) legacy.close();
    if (upgraded?.isOpen) upgraded.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('版本13迁移新增活动建议关闭记录并保留旧标签', () => {
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
      INSERT INTO schema_version (id, version) VALUES (1, 13);
      CREATE TABLE tags (id INTEGER PRIMARY KEY, text TEXT NOT NULL);
      INSERT INTO tags VALUES (5, '保留画像');
    `);
    legacy.close();
    legacy = undefined;

    upgraded = openDatabase(databasePath);
    const version = upgraded.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number };
    const dismissalTable = upgraded.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'activity_suggestion_dismissals'",
    ).get();
    const preserved = upgraded.prepare('SELECT text FROM tags WHERE id = 5').get() as { text: string };

    assert.equal(version.version, 23);
    assert.ok(dismissalTable);
    assert.equal(preserved.text, '保留画像');
  } finally {
    if (legacy?.isOpen) legacy.close();
    if (upgraded?.isOpen) upgraded.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('版本 2 数据库迁移 pipeline_traces 时保留既有调试记录', () => {
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
      INSERT INTO schema_version (id, version) VALUES (1, 2);
      CREATE TABLE debug_traces (
        id INTEGER PRIMARY KEY, time INTEGER NOT NULL, session_id TEXT NOT NULL,
        message_id TEXT NOT NULL, slot TEXT NOT NULL, provider TEXT NOT NULL,
        model TEXT NOT NULL, prompt_json TEXT NOT NULL, response_text TEXT NOT NULL,
        prompt_hash TEXT NOT NULL, detail_json TEXT NOT NULL
      );
      INSERT INTO debug_traces VALUES (1, 7, 's', 'm', 'reply', 'provider', 'model', '[]', 'kept', 'hash', '{}');
    `);
    legacy.close();
    legacy = undefined;

    upgraded = openDatabase(databasePath);
    const version = upgraded.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number };
    const retained = upgraded.prepare('SELECT response_text FROM debug_traces WHERE id = 1').get() as { response_text: string };

    assert.equal(version.version, 23);
    assert.equal(retained.response_text, 'kept');
    assert.equal(upgraded.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pipeline_traces'").get() !== undefined, true);
  } finally {
    if (legacy?.isOpen) legacy.close();
    if (upgraded?.isOpen) upgraded.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('版本 1 数据库会升级到包含调试追踪与情绪表的当前版本', () => {
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

    assert.equal(version.version, 23);
    assert.equal(table?.name, 'debug_traces');
    assert.equal(upgraded.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pipeline_traces'").get() !== undefined, true);
  } finally {
    if (legacy?.isOpen) legacy.close();
    if (upgraded?.isOpen) upgraded.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('版本 3 数据库迁移到版本 23 时新增情绪、好感度、人设版本与标签表', () => {
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
      INSERT INTO schema_version (id, version) VALUES (1, 3);
      CREATE TABLE pipeline_traces (
        id INTEGER PRIMARY KEY, time INTEGER NOT NULL, session_id TEXT NOT NULL,
        message_id TEXT NOT NULL, trace_json TEXT NOT NULL,
        UNIQUE (session_id, message_id)
      );
      INSERT INTO pipeline_traces VALUES (1, 7, 's', 'm', '[{"step":"gate"}]');
    `);
    legacy.close();
    legacy = undefined;

    upgraded = openDatabase(databasePath);
    const version = upgraded.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number };
    const tables = upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('affinity_events', 'affinity_state', 'mood_state', 'mood_events', 'tags', 'tag_runs') ORDER BY name")
      .all() as Array<{ name: string }>;
    const retained = upgraded.prepare('SELECT trace_json FROM pipeline_traces WHERE id = 1').get() as { trace_json: string };

    assert.equal(version.version, 23);
    assert.deepEqual(tables.map((table) => table.name), [
      'affinity_events', 'affinity_state', 'mood_events', 'mood_state', 'tag_runs', 'tags',
    ]);
    assert.equal(retained.trace_json, '[{"step":"gate"}]');
  } finally {
    if (legacy?.isOpen) legacy.close();
    if (upgraded?.isOpen) upgraded.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('版本 4 数据库迁移到版本 23 并保留既有数据', () => {
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
      INSERT INTO schema_version (id, version) VALUES (1, 4);
      CREATE TABLE existing_fact (value TEXT NOT NULL);
      INSERT INTO existing_fact VALUES ('preserved');
      CREATE TABLE mood_events (
        id INTEGER PRIMARY KEY, account INTEGER NOT NULL, time INTEGER NOT NULL,
        source TEXT NOT NULL, session_id TEXT, sender_id INTEGER,
        dv REAL NOT NULL, da REAL NOT NULL, applied_dv REAL NOT NULL, applied_da REAL NOT NULL,
        reason TEXT NOT NULL, band_before TEXT, band_after TEXT
      );
    `);
    legacy.prepare(`
      INSERT INTO mood_events
        (id, account, time, source, session_id, sender_id, dv, da, applied_dv, applied_da, reason, band_before, band_after)
      VALUES (1, 123, 100, 'rule', NULL, NULL, 0, 0, 0, 0, 'legacy', NULL, NULL)
    `).run();
    legacy.close();
    legacy = undefined;

    upgraded = openDatabase(databasePath);
    const version = upgraded.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number };
    const retained = upgraded.prepare('SELECT value FROM existing_fact').get() as { value: string };
    const retainedMood = upgraded.prepare('SELECT id, valence_after, arousal_after FROM mood_events WHERE id = 1')
      .get() as { id: number; valence_after: number | null; arousal_after: number | null };
    const affinityTables = upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('affinity_state', 'affinity_events') ORDER BY name")
      .all() as Array<{ name: string }>;

    assert.equal(version.version, 23);
    assert.deepEqual(affinityTables.map((table) => table.name), ['affinity_events', 'affinity_state']);
    assert.equal(retained.value, 'preserved');
    assert.equal(retainedMood.id, 1);
    assert.equal(retainedMood.valence_after, null);
    assert.equal(retainedMood.arousal_after, null);
  } finally {
    if (legacy?.isOpen) legacy.close();
    if (upgraded?.isOpen) upgraded.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('版本 5 用量迁移保留旧行并将账号标记为未知', () => {
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
      INSERT INTO schema_version (id, version) VALUES (1, 5);
      CREATE TABLE usage (
        id INTEGER PRIMARY KEY,
        time INTEGER NOT NULL,
        slot TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        cached_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cost_cny REAL NOT NULL,
        latency_ms INTEGER NOT NULL,
        ok INTEGER NOT NULL CHECK (ok IN (0, 1))
      );
      CREATE TABLE mood_events (
        id INTEGER PRIMARY KEY, account INTEGER NOT NULL, time INTEGER NOT NULL,
        source TEXT NOT NULL, session_id TEXT, sender_id INTEGER,
        dv REAL NOT NULL, da REAL NOT NULL, applied_dv REAL NOT NULL, applied_da REAL NOT NULL,
        reason TEXT NOT NULL, band_before TEXT, band_after TEXT
      );
    `);
    legacy.prepare(`
      INSERT INTO usage (time, slot, provider, model, input_tokens, cached_tokens, output_tokens, cost_cny, latency_ms, ok)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(new Date(2026, 9, 12, 12).getTime(), 'reply', 'deepseek', 'test-model', 10, 0, 4, 0.001, 12, 1);
    legacy.close();
    legacy = undefined;

    upgraded = openDatabase(databasePath);
    const columns = upgraded.prepare("PRAGMA table_info('usage')").all() as Array<{ name: string; notnull: number }>;
    const accountColumn = columns.find((column) => column.name === 'account');
    assert.ok(accountColumn);
    assert.equal(accountColumn.notnull, 0);
    const oldRow = upgraded.prepare('SELECT id, account FROM usage WHERE id = 1').get() as { id: number; account: number | null };
    const version = upgraded.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number };
    assert.equal(oldRow.id, 1);
    assert.equal(oldRow.account, null);
    assert.equal(version.version, 23);
  } finally {
    if (legacy?.isOpen) legacy.close();
    if (upgraded?.isOpen) upgraded.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('版本 10 迁移新增私聊事实与运行游标并保留原消息', () => {
  const { root, databasePath } = createDatabaseFixture();
  let database: DatabaseSync | undefined;
  try {
    database = openDatabase(databasePath);
    database.prepare(`
      INSERT INTO messages (session_id, message_id, sender_id, sender_name, is_self, plain_text, segments_json, time)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('900000001:private:42', 'privacy-migration', 42, '小明', 0, '最近在备考', '[]', 123);
    database.exec(`
      DROP TABLE IF EXISTS private_facts;
      DROP TABLE IF EXISTS privacy_runs;
      UPDATE schema_version SET version = 10 WHERE id = 1;
    `);
    database.close();

    database = openDatabase(databasePath);
    const version = database.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number };
    const factColumns = database.prepare("PRAGMA table_info('private_facts')").all() as Array<{ name: string }>;
    const runColumns = database.prepare("PRAGMA table_info('privacy_runs')").all() as Array<{ name: string }>;
    const retained = database.prepare('SELECT plain_text FROM messages WHERE message_id = ?')
      .get('privacy-migration') as { plain_text: string };

    assert.equal(version.version, 23);
    assert.deepEqual(factColumns.map(({ name }) => name), [
      'id', 'account', 'owner_id', 'session_id', 'text', 'keywords_json', 'level', 'level_source',
      'mentions', 'mention_evidence_json', 'evidence_json', 'status', 'created_at', 'updated_at',
    ]);
    assert.deepEqual(runColumns.map(({ name }) => name), [
      'account', 'session_id', 'last_run_at', 'last_message_time',
    ]);
    assert.equal(retained.plain_text, '最近在备考');
    database.prepare(`
      INSERT INTO private_facts
        (account, owner_id, session_id, text, keywords_json, level, level_source, mentions,
         mention_evidence_json, evidence_json, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(900000001, 42, '900000001:private:42', '最近在备考，压力较大', '["备考","压力"]',
      'L0', 'auto', 0, '[]', '[]', 'active', 1, 1);
    assert.throws(() => database?.prepare(`
      INSERT INTO private_facts
        (account, owner_id, session_id, text, keywords_json, level, level_source, mentions,
         mention_evidence_json, evidence_json, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(900000001, 42, '900000001:private:42', '非法等级', '[]', 'L3', 'auto', 0, '[]', '[]', 'active', 1, 1));
  } finally {
    if (database?.isOpen) database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
