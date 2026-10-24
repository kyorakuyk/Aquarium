import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/store/db.ts';
import { CURRENT_SCHEMA_VERSION } from './schema-version.ts';

test('v30 好感迁移保留相对关系、换算历史并建立人设隔离表', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-affinity-v30-'));
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
      INSERT INTO schema_version (id, version) VALUES (1, 30);
      CREATE TABLE affinity_state (
        account INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        value REAL NOT NULL CHECK (value >= 0 AND value <= 100),
        level TEXT NOT NULL CHECK (level IN ('cold', 'cool', 'neutral', 'warm', 'close')),
        level_since INTEGER NOT NULL,
        last_level_change_at INTEGER NOT NULL,
        last_interaction_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (account, user_id)
      );
      INSERT INTO affinity_state VALUES
        (900000001, 42, 78, 'warm', 900, 800, 700, 1000),
        (900000001, 43, 0, 'cold', 900, 800, 700, 1000),
        (900000001, 44, 100, 'close', 900, 800, 700, 1000);
      CREATE TABLE affinity_events (
        id INTEGER PRIMARY KEY,
        account INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        time INTEGER NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('appraise', 'called', 'manual', 'band')),
        session_id TEXT,
        delta REAL NOT NULL,
        applied REAL NOT NULL,
        reason TEXT NOT NULL,
        level_before TEXT CHECK (level_before IS NULL OR level_before IN ('cold', 'cool', 'neutral', 'warm', 'close')),
        level_after TEXT CHECK (level_after IS NULL OR level_after IN ('cold', 'cool', 'neutral', 'warm', 'close'))
      );
      CREATE INDEX idx_affinity_events_account_user_time ON affinity_events (account, user_id, time);
      INSERT INTO affinity_events VALUES (7, 900000001, 42, 1000, 'appraise', '900000001:group:123456', 1.25, 1, '旧事件', 'neutral', 'warm');
    `);
    legacy.close();
    legacy = undefined;

    upgraded = openDatabase(databasePath, { affinityStart: 22 });
    const version = upgraded.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number };
    const state = upgraded.prepare('SELECT * FROM affinity_state WHERE account = ? AND user_id = ?')
      .get(900000001, 42) as Record<string, unknown>;
    const migratedStates = (upgraded.prepare('SELECT user_id, value, level FROM affinity_state ORDER BY user_id')
      .all() as Array<{ user_id: number; value: number; level: string }>).map(({ user_id, value, level }) => ({
      user_id, value, level,
    }));
    const event = upgraded.prepare('SELECT * FROM affinity_events WHERE id = 7')
      .get() as Record<string, unknown>;
    const personaStates = upgraded.prepare('SELECT COUNT(*) AS count FROM persona_affinity_state').get() as { count: number };

    assert.equal(version.version, CURRENT_SCHEMA_VERSION);
    assert.equal(state.value, 56);
    assert.equal(state.level, 'ordinary_friend');
    assert.deepEqual(migratedStates, [
      { user_id: 42, value: 56, level: 'ordinary_friend' },
      { user_id: 43, value: -100, level: 'enemy' },
      { user_id: 44, value: 100, level: 'lover' },
    ]);
    assert.equal(event.delta, 2.5);
    assert.equal(event.applied, 2);
    assert.equal(event.level_before, 'unfamiliar');
    assert.equal(event.level_after, 'ordinary_friend');
    assert.equal(event.reason, '旧事件');
    assert.equal(event.session_id, '900000001:group:123456');
    assert.equal(personaStates.count, 0);
  } finally {
    if (legacy?.isOpen) legacy.close();
    if (upgraded?.isOpen) upgraded.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
