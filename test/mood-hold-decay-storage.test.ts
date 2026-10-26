import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { openDatabase } from '../src/store/db.ts';

test('v42 为既有 mood 状态与事件添加可空锚点列并保留旧值', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-mood-hold-v42-'));
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
      INSERT INTO schema_version (id, version) VALUES (1, 41);
      CREATE TABLE mood_state (
        account INTEGER PRIMARY KEY,
        valence REAL NOT NULL,
        arousal REAL NOT NULL,
        dominance REAL NOT NULL
      );
      INSERT INTO mood_state VALUES (900000001, 0.55, 0.75, -0.2);
      CREATE TABLE mood_events (
        id INTEGER PRIMARY KEY,
        valence_after REAL,
        arousal_after REAL,
        dominance_after REAL
      );
      INSERT INTO mood_events VALUES (1, 0.52, 0.71, -0.15);
    `);
    legacy.close();
    legacy = undefined;

    upgraded = openDatabase(databasePath);
    const version = upgraded.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number };
    const stateColumns = upgraded.prepare("PRAGMA table_info('mood_state')").all() as Array<{
      name: string;
      type: string;
      notnull: number;
    }>;
    const eventColumns = upgraded.prepare("PRAGMA table_info('mood_events')").all() as Array<{
      name: string;
      type: string;
      notnull: number;
    }>;
    const state = upgraded.prepare('SELECT * FROM mood_state WHERE account = ?').get(900000001) as Record<string, unknown>;
    const event = upgraded.prepare('SELECT * FROM mood_events WHERE id = 1').get() as Record<string, unknown>;
    const stateAnchors = ['valence_d0', 'valence_u', 'arousal_d0', 'arousal_u', 'dominance_d0', 'dominance_u'];
    const eventAnchors = ['valence_u_after', 'arousal_u_after', 'dominance_u_after'];

    assert.equal(version.version, 42);
    for (const name of stateAnchors) {
      const column = stateColumns.find((item) => item.name === name);
      assert.ok(column, `mood_state.${name} should exist`);
      assert.equal(column.type, 'REAL');
      assert.equal(column.notnull, 0);
      assert.equal(state[name], null);
    }
    for (const name of eventAnchors) {
      const column = eventColumns.find((item) => item.name === name);
      assert.ok(column, `mood_events.${name} should exist`);
      assert.equal(column.type, 'REAL');
      assert.equal(column.notnull, 0);
      assert.equal(event[name], null);
    }
    assert.deepEqual(
      { valence: state.valence, arousal: state.arousal, dominance: state.dominance },
      { valence: 0.55, arousal: 0.75, dominance: -0.2 },
    );
    assert.deepEqual(
      { valenceAfter: event.valence_after, arousalAfter: event.arousal_after, dominanceAfter: event.dominance_after },
      { valenceAfter: 0.52, arousalAfter: 0.71, dominanceAfter: -0.15 },
    );
  } finally {
    if (legacy?.isOpen) legacy.close();
    if (upgraded?.isOpen) upgraded.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
