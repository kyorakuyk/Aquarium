import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/store/db.ts';
import { CURRENT_SCHEMA_VERSION } from './schema-version.ts';

test('v27 情绪数据迁移保留旧事件并初始化心灵能量', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-mood-reserve-'));
  const databasePath = path.join(root, 'aquarium.db');
  let legacy: DatabaseSync | undefined;
  let upgraded: DatabaseSync | undefined;
  try {
    legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE schema_version (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL
      );
      INSERT INTO schema_version (id, version) VALUES (1, 26);
      CREATE TABLE mood_state (
        account INTEGER PRIMARY KEY,
        valence REAL NOT NULL,
        arousal REAL NOT NULL,
        updated_at INTEGER NOT NULL,
        band TEXT NOT NULL,
        band_since INTEGER NOT NULL,
        last_band_change_at INTEGER NOT NULL
      );
      INSERT INTO mood_state VALUES (900000001, -0.2, 0.7, 1000, 'annoyed', 900, 800);
      CREATE TABLE mood_events (
        id INTEGER PRIMARY KEY,
        account INTEGER NOT NULL,
        time INTEGER NOT NULL,
        source TEXT NOT NULL,
        session_id TEXT,
        sender_id INTEGER,
        dv REAL NOT NULL,
        da REAL NOT NULL,
        applied_dv REAL NOT NULL,
        applied_da REAL NOT NULL,
        reason TEXT NOT NULL,
        band_before TEXT,
        band_after TEXT,
        valence_after REAL,
        arousal_after REAL
      );
      INSERT INTO mood_events VALUES (1, 900000001, 1000, 'appraise', '900000001:private:42', 42, -0.1, 0.2, -0.1, 0.2, '旧事件', 'calm', 'annoyed', -0.2, 0.7);
    `);
    legacy.close();
    legacy = undefined;

    upgraded = openDatabase(databasePath);
    const version = upgraded.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number };
    const state = upgraded.prepare('SELECT * FROM mood_state WHERE account = ?').get(900000001) as Record<string, unknown>;
    const event = upgraded.prepare('SELECT * FROM mood_events WHERE id = 1').get() as Record<string, unknown>;

    assert.equal(version.version, CURRENT_SCHEMA_VERSION);
    assert.equal(state.valence, -0.2);
    assert.equal(state.arousal, 0.7);
    assert.equal(state.dominance, 0);
    assert.equal(state.band, 'unpleasant');
    assert.equal(state.main_emotion, null);
    assert.equal(state.emotion_since, null);
    assert.equal(state.last_emotion_change_at, null);
    assert.equal(state.reserve, 0.8);
    assert.equal(state.reserve_band, 'full');
    assert.equal(state.reserve_band_since, null);
    assert.equal(state.reserve_last_change_at, null);
    assert.equal(state.last_reply_at, null);
    assert.equal(event.reason, '旧事件');
    assert.equal(event.appraisal_valid, null);
    assert.equal(event.dr, 0);
    assert.equal(event.applied_dr, 0);
    assert.equal(event.absorbed, 0);
    assert.equal(event.reserve_after, null);
    assert.equal(event.dd, 0);
    assert.equal(event.applied_dd, 0);
    assert.equal(event.dominance_after, 0);
    assert.equal(event.cause_tag, null);
    assert.equal(event.band_before, null);
    assert.equal(event.band_after, 'unpleasant');

    upgraded.close();
    upgraded = undefined;
    legacy = new DatabaseSync(databasePath);
    legacy.prepare('UPDATE schema_version SET version = 31 WHERE id = 1').run();
    legacy.close();
    legacy = undefined;
    upgraded = openDatabase(databasePath);
    const reenteredState = upgraded.prepare('SELECT * FROM mood_state WHERE account = ?').get(900000001) as Record<string, unknown>;
    const reenteredEvent = upgraded.prepare('SELECT * FROM mood_events WHERE id = 1').get() as Record<string, unknown>;
    assert.equal(reenteredState.dominance, 0);
    assert.equal(reenteredState.band, 'unpleasant');
    assert.equal(reenteredEvent.band_after, 'unpleasant');
  } finally {
    if (legacy?.isOpen) legacy.close();
    if (upgraded?.isOpen) upgraded.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
