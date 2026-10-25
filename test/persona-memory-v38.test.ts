import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/store/db.ts';
import { createRepository } from '../src/store/repository.ts';

test('v38 archives raw memos and creates event memos with source and privacy fields', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-memory-v38-'));
  const databasePath = path.join(root, 'aquarium.db');
  let legacy: DatabaseSync | undefined;
  let upgraded: DatabaseSync | undefined;
  try {
    legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
      INSERT INTO schema_version VALUES (1, 37);
      CREATE TABLE persona_memos (
        id INTEGER PRIMARY KEY, account INTEGER NOT NULL, session_id TEXT NOT NULL,
        message_id TEXT NOT NULL, sender_id INTEGER NOT NULL, sender_name TEXT NOT NULL,
        is_self INTEGER NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL,
        processed_cycle_key TEXT
      );
      CREATE INDEX idx_persona_memos_account_created ON persona_memos (account, created_at DESC, id DESC);
      CREATE INDEX idx_persona_memos_pending ON persona_memos (account, processed_cycle_key, created_at);
      INSERT INTO persona_memos VALUES
        (1, 7101, '7101:private:82', 'legacy-1', 82, '朋友', 0, '原始记录归档', 100, NULL);
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, message_id TEXT NOT NULL,
        sender_id INTEGER NOT NULL, sender_name TEXT NOT NULL, is_self INTEGER NOT NULL,
        plain_text TEXT NOT NULL, segments_json TEXT NOT NULL, time INTEGER NOT NULL
      );
      INSERT INTO messages VALUES
        (1, '7101:private:82', 'cutoff-processed', 82, '朋友', 0, '已处理', '[]', 100),
        (2, '7101:private:82', 'cutoff-pending', 83, '朋友', 0, '同一秒未处理', '[]', 100),
        (3, '7101:private:82', 'late-older', 83, '朋友', 0, '迟到的旧消息', '[]', 99),
        (4, '7101:private:82', 'after-cutoff', 83, '朋友', 0, '之后的消息', '[]', 101);
      CREATE TABLE memory_cursors (
        account INTEGER NOT NULL, session_id TEXT NOT NULL,
        organized_until_message_time INTEGER, open_segment_start INTEGER,
        PRIMARY KEY (account, session_id)
      );
      INSERT INTO memory_cursors VALUES (7101, '7101:private:82', 100, NULL);
    `);
    legacy.close();
    legacy = undefined;

    upgraded = openDatabase(databasePath);
    const tables = upgraded.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table'
        AND name IN ('persona_memos', 'persona_memos_legacy_v26', 'persona_memory_tails')
      ORDER BY name
    `).all().map((row) => (row as { name: string }).name);
    assert.deepEqual(tables, ['persona_memory_tails', 'persona_memos', 'persona_memos_legacy_v26']);

    const version = upgraded.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number };
    assert.equal(version.version, 38);
    const archived = upgraded.prepare('SELECT text FROM persona_memos_legacy_v26 WHERE id = 1').get() as { text: string };
    assert.equal(archived.text, '原始记录归档');
    const cursor = upgraded.prepare(`
      SELECT organized_until_message_row_id FROM memory_cursors WHERE account = 7101 AND session_id = '7101:private:82'
    `).get() as { organized_until_message_row_id: number | null };
    assert.equal(cursor.organized_until_message_row_id, null);

    const columns = upgraded.prepare('PRAGMA table_info(persona_memos)').all()
      .map((row) => (row as { name: string }).name);
    for (const column of [
      'account', 'session_id', 'event_id', 'title', 'summary', 'participants_json',
      'start_msg', 'end_msg', 'level', 'created_at', 'diary_cycle',
    ]) assert.ok(columns.includes(column), `missing persona_memos.${column}`);
  } finally {
    if (legacy?.isOpen) legacy.close();
    if (upgraded?.isOpen) upgraded.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('event memos and scattered-tail references round-trip through the repository', () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    const eventId = repository.upsertGroupEvent({
      account: 7101,
      sourceGroupId: 82,
      anchorMessageId: 'event-start',
      title: '一起看展',
      summary: '几位群友约好周末看展。',
      participantIds: [82, 83],
      evidenceMessageIds: ['event-start', 'event-end'],
      occurredAt: 100,
      createdAt: 200,
      updatedAt: 200,
    });
    const memo = {
      account: 7101,
      sessionId: '7101:group:82',
      eventId,
      title: '一起看展',
      summary: '几位群友约好周末看展。',
      participantIds: [82, 83],
      startMessageId: 'event-start',
      endMessageId: 'event-end',
      level: 'L0' as const,
      createdAt: 200,
    };
    assert.equal(repository.insertPersonaEventMemo(memo), true);
    assert.equal(repository.insertPersonaEventMemo(memo), false);
    assert.deepEqual(repository.listPersonaEventMemos(7101, 10), [{ id: 1, ...memo, diaryCycle: null }]);

    assert.equal(repository.savePersonaMemoryTailMessages({
      account: 7101,
      sessionId: '7101:group:82',
      messages: [{ messageId: 'tail-1', createdAt: 300 }],
    }), 1);
    assert.deepEqual(repository.listPersonaMemoryTailMessages(7101, 10), [{
      account: 7101,
      sessionId: '7101:group:82',
      messageId: 'tail-1',
      createdAt: 300,
      diaryCycle: null,
    }]);
  } finally {
    database.close();
  }
});
