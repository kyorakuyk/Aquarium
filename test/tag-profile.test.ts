import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/store/db.ts';
import { createRepository } from '../src/store/repository.ts';
import { createTagSubjectRepository } from '../src/store/tag-subject-repo.ts';
import {
  canonicalizeTagSubject,
  normalizeTagSubject,
  TAG_CATEGORY_HALF_LIFE_MS,
  TAG_CATEGORY_KEYS,
} from '../src/core/impressions/tag-model.ts';
import { migration as migration16 } from '../src/store/migrations/v16.ts';

const legacyTagColumns = [
  'id', 'account', 'session_id', 'user_id', 'text', 'norm', 'status', 'source',
  'samples', 'evidence_json', 'first_seen', 'last_seen', 'superseded_by', 'updated_at',
];

test('v11 数据库升级到 v21 时保留画像字段默认值并标记旧群标签', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-tag-profile-'));
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
      INSERT INTO schema_version (id, version) VALUES (1, 11);
      CREATE TABLE tags (
        id INTEGER PRIMARY KEY,
        account INTEGER NOT NULL,
        session_id TEXT NOT NULL,
        user_id INTEGER,
        text TEXT NOT NULL,
        norm TEXT NOT NULL,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        samples INTEGER NOT NULL,
        evidence_json TEXT NOT NULL,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        superseded_by INTEGER,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO tags VALUES
        (1, 7, '7:group:8', 42, '爱游戏', '爱游戏', 'confirmed', 'auto', 2, '[]', 10, 20, NULL, 20),
        (2, 7, '7:group:8', NULL, '群旧标签', '群旧标签', 'candidate', 'auto', 1, '[]', 10, 20, NULL, 20);
    `);
    legacy.close();
    legacy = undefined;

    upgraded = openDatabase(databasePath);
    const version = upgraded.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number };
    const columns = upgraded.prepare("PRAGMA table_info('tags')").all() as Array<{ name: string }>;
    const tag = upgraded.prepare('SELECT * FROM tags WHERE id = 1').get() as Record<string, unknown>;
    const subjects = upgraded.prepare("PRAGMA table_info('tag_subjects')").all() as Array<{ name: string }>;

    assert.equal(version.version, 21);
    assert.deepEqual(columns.map((column) => column.name), [
      ...legacyTagColumns, 'category', 'subject', 'polarity', 'origin', 'locked', 'needs_reclassification',
    ]);
    assert.equal(tag.text, '爱游戏');
    assert.equal(tag.category, 'misc');
    assert.equal(tag.subject, null);
    assert.equal(tag.polarity, null);
    assert.equal(tag.origin, 'inferred');
    assert.equal(tag.locked, 0);
    assert.equal(tag.needs_reclassification, 0);
    const groupTag = upgraded.prepare('SELECT category, needs_reclassification FROM tags WHERE id = 2').get() as {
      category: string;
      needs_reclassification: number;
    };
    assert.equal(groupTag.category, 'misc');
    assert.equal(groupTag.needs_reclassification, 1);
    assert.deepEqual(subjects.map((column) => column.name), [
      'id', 'account', 'category', 'name', 'aliases_json',
    ]);
  } finally {
    if (legacy?.isOpen) legacy.close();
    if (upgraded?.isOpen) upgraded.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('subject 归一去空白与标点并将别名映射到 canonical name', () => {
  const subjects = [{ name: '守望先锋', aliases: ['OW', 'C.S.G.O.'] }];

  assert.equal(normalizeTagSubject(' C.S.G.O. '), 'csgo');
  assert.equal(canonicalizeTagSubject(' CSGO ', subjects), '守望先锋');
  assert.equal(canonicalizeTagSubject(' 原神 ', subjects), '原神');
});

test('taxonomy v2 限定分类 key、半衰期与多级 subject 别名按级归一', () => {
  const dayMs = 24 * 60 * 60 * 1000;
  assert.deepEqual(TAG_CATEGORY_KEYS, [
    'positioning', 'topic', 'atmosphere', 'meme', 'norms', 'identity', 'personality', 'fandom',
    'speech', 'catchphrase', 'social', 'recent', 'dislike', 'schedule',
  ]);
  assert.equal(TAG_CATEGORY_HALF_LIFE_MS.positioning, 180 * dayMs);
  assert.equal(TAG_CATEGORY_HALF_LIFE_MS.topic, 30 * dayMs);
  assert.equal(TAG_CATEGORY_HALF_LIFE_MS.meme, 60 * dayMs);
  assert.equal(TAG_CATEGORY_HALF_LIFE_MS.norms, 180 * dayMs);
  assert.equal(TAG_CATEGORY_HALF_LIFE_MS.catchphrase, 60 * dayMs);
  assert.equal(TAG_CATEGORY_HALF_LIFE_MS.schedule, null);

  const subjects = [
    { name: 'FPS', aliases: ['First Person Shooter'] },
    { name: 'Apex Legends', aliases: ['AL'] },
  ];
  assert.equal(canonicalizeTagSubject(' First Person Shooter / AL ', subjects), 'FPS/Apex Legends');
});

test('v16 保留旧群氛围分类并标记为待整理', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec(`
      CREATE TABLE tags (
        id INTEGER PRIMARY KEY,
        user_id INTEGER,
        category TEXT NOT NULL,
        locked INTEGER NOT NULL,
        status TEXT NOT NULL
      );
      INSERT INTO tags (id, user_id, category, locked, status)
      VALUES (1, NULL, 'atmosphere', 0, 'confirmed');
    `);

    migration16.up(database);
    migration16.up(database);

    const tag = database.prepare('SELECT category, needs_reclassification FROM tags WHERE id = 1').get() as {
      category: string;
      needs_reclassification: number;
    };
    assert.equal(tag.category, 'atmosphere');
    assert.equal(tag.needs_reclassification, 1);
  } finally {
    database.close();
  }
});

test('标签写入按账户和类别将 subject 别名归一为 canonical name', () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    const subjects = createTagSubjectRepository(database);
    subjects.saveTagSubject({
      account: 7,
      category: 'fandom',
      name: '守望先锋',
      aliases: ['OW', 'C.S.G.O.'],
    });

    const id = repository.insertTag({
      account: 7,
      sessionId: '7:group:8',
      userId: 42,
      text: '喜欢游戏',
      norm: '喜欢游戏',
      category: 'fandom',
      subject: ' CSGO ',
      polarity: 'like',
      origin: 'inferred',
      locked: false,
      status: 'candidate',
      source: 'auto',
      samples: 1,
      evidence: [],
      firstSeen: 1,
      lastSeen: 1,
      supersededBy: null,
      updatedAt: 1,
    });

    assert.equal(repository.tagById(id)?.subject, '守望先锋');
    repository.updateTag(id, { subject: 'O.W.', locked: true });
    assert.equal(repository.tagById(id)?.subject, '守望先锋');
    assert.equal(repository.tagById(id)?.locked, true);
    assert.equal(subjects.canonicalTagSubject(8, 'fandom', 'CSGO'), 'CSGO');
    assert.equal(subjects.canonicalTagSubject(7, 'personality', 'CSGO'), 'CSGO');
    assert.deepEqual(subjects.listTagSubjects(7, 'fandom'), [{
      id: 1,
      account: 7,
      category: 'fandom',
      name: '守望先锋',
      aliases: ['OW', 'C.S.G.O.'],
    }]);
  } finally {
    database.close();
  }
});

test('topic 写入时按路径级别将多级 subject 别名归一', () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    const subjects = createTagSubjectRepository(database);
    subjects.saveTagSubject({ account: 7, category: 'topic', name: '游戏', aliases: ['玩法'] });
    subjects.saveTagSubject({ account: 7, category: 'topic', name: 'FPS', aliases: ['F.P.S.'] });
    const id = repository.insertTag({
      account: 7,
      sessionId: '7:group:8',
      userId: null,
      text: 'CS2',
      norm: 'cs2',
      category: 'topic',
      subject: '玩法/FPS',
      polarity: null,
      origin: 'inferred',
      locked: false,
      status: 'candidate',
      source: 'auto',
      samples: 1,
      evidence: [],
      firstSeen: 1,
      lastSeen: 1,
      supersededBy: null,
      updatedAt: 1,
    });

    assert.equal(repository.tagById(id)?.subject, '游戏/FPS');
  } finally {
    database.close();
  }
});
