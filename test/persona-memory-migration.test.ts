import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/store/db.ts';

test('v37 backfills organized time and pending start from legacy messages and memos', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-memory-cursor-backfill-'));
  const databasePath = path.join(root, 'aquarium.db');
  let legacy: DatabaseSync | undefined;
  let upgraded: DatabaseSync | undefined;
  try {
    legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
      INSERT INTO schema_version VALUES (1, 36);
      CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, message_id TEXT NOT NULL, time INTEGER NOT NULL);
      CREATE TABLE persona_memos (
        id INTEGER PRIMARY KEY, account INTEGER NOT NULL, session_id TEXT NOT NULL,
        message_id TEXT NOT NULL, sender_id INTEGER NOT NULL, sender_name TEXT NOT NULL,
        is_self INTEGER NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL, processed_cycle_key TEXT
      );
      INSERT INTO messages VALUES
        (1, '7101:group:82', 'done-1', 100),
        (2, '7101:group:82', 'pending-1', 200),
        (3, '7101:private:83', 'private-1', 300),
        (4, 'invalid:group:82', 'invalid', 400);
      INSERT INTO persona_memos VALUES
        (1, 7101, '7101:group:82', 'done-1', 82, '朋友', 0, '已整理消息', 100, '2026-10-20');
    `);
    legacy.close();
    legacy = undefined;

    upgraded = openDatabase(databasePath);
    const getCursor = upgraded.prepare(`
      SELECT account, session_id, organized_until_message_time, open_segment_start
      FROM memory_cursors WHERE account = ? AND session_id = ?
    `);
    const groupCursor = { ...getCursor.get(7101, '7101:group:82') } as Record<string, unknown>;
    const privateCursor = { ...getCursor.get(7101, '7101:private:83') } as Record<string, unknown>;
    assert.deepEqual(groupCursor, {
      account: 7101,
      session_id: '7101:group:82',
      organized_until_message_time: 100,
      open_segment_start: 200,
    });
    assert.deepEqual(privateCursor, {
      account: 7101,
      session_id: '7101:private:83',
      organized_until_message_time: null,
      open_segment_start: 300,
    });
    assert.equal(getCursor.get(7101, '7101:group:82x'), undefined);
  } finally {
    if (legacy?.isOpen) legacy.close();
    if (upgraded?.isOpen) upgraded.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
