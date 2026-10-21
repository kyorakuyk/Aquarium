import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createMemberSummaryRepository } from '../src/store/member-summary-repo.ts';
import { openDatabase } from '../src/store/db.ts';

test('schema v21 still creates the member summary table', () => {
  const database = openDatabase(':memory:');
  try {
    const version = database.prepare('SELECT version FROM schema_version WHERE id = 1').get() as {
      version: number;
    };
    const columns = (database.prepare("PRAGMA table_info('member_summaries')").all() as Array<{ name: string }>)
      .map(({ name }) => name);

    assert.equal(version.version, 21);
    assert.deepEqual(columns, ['account', 'user_id', 'text', 'manual', 'updated_at']);
  } finally {
    database.close();
  }
});

test('v14 migration creates member summaries and preserves existing messages', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-member-summary-'));
  const file = path.join(root, 'aquarium.db');
  let database: DatabaseSync | undefined;
  try {
    database = openDatabase(file);
    database.prepare(`
      INSERT INTO messages (session_id, message_id, sender_id, sender_name, is_self, plain_text, segments_json, time)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('900000001:group:123456', 'kept-message', 42, '群友', 0, '保留消息', '[]', 100);
    database.exec('DROP TABLE member_summaries; UPDATE schema_version SET version = 14 WHERE id = 1;');
    database.close();

    database = openDatabase(file);
    const version = database.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number };
    const retained = database.prepare('SELECT plain_text FROM messages WHERE message_id = ?')
      .get('kept-message') as { plain_text: string };
    const columns = database.prepare("PRAGMA table_info('member_summaries')").all() as Array<{ name: string }>;

    assert.equal(version.version, 21);
    assert.equal(retained.plain_text, '保留消息');
    assert.deepEqual(columns.map(({ name }) => name), ['account', 'user_id', 'text', 'manual', 'updated_at']);
  } finally {
    if (database?.isOpen) database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('auto summary persists, and cannot replace a manual summary', () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createMemberSummaryRepository(database);
    assert.equal(repository.get(900000001, 42), undefined);
    assert.equal(repository.saveGenerated({
      account: 900000001,
      userId: 42,
      text: '喜欢安静地交流。',
      updatedAt: 100,
    }), true);
    assert.deepEqual(repository.get(900000001, 42), {
      account: 900000001,
      userId: 42,
      text: '喜欢安静地交流。',
      manual: false,
      updatedAt: 100,
    });

    repository.saveManual({
      account: 900000001,
      userId: 42,
      text: '主人手动写的印象。',
      updatedAt: 200,
    });
    assert.equal(repository.saveGenerated({
      account: 900000001,
      userId: 42,
      text: '自动摘要不可覆盖。',
      updatedAt: 300,
    }), false);
    assert.deepEqual(repository.get(900000001, 42), {
      account: 900000001,
      userId: 42,
      text: '主人手动写的印象。',
      manual: true,
      updatedAt: 200,
    });
  } finally {
    database.close();
  }
});
