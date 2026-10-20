import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/store/db.ts';
import { createRepository, type ImageCaptionRecord } from '../src/store/repository.ts';

function tempDatabase() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-image-caption-'));
  return { directory, file: path.join(directory, 'aquarium.db') };
}

test('MD5 图片认知缓存按结构化含义读写并保留识别模型和模板版本', () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database, () => new Date(123));
    const record: ImageCaptionRecord = {
      md5: 'a'.repeat(32),
      caption: '[截图：聊天窗口｜文字：“你好”]',
      kind: 'screenshot',
      desc: '聊天窗口',
      text: '你好',
      legible: true,
      visionModel: 'vision-model-a',
      visionTemplateVersion: 'template-a',
      time: 123,
    };

    repository.setImageCaption(record);
    assert.deepEqual(repository.getImageCaption(record.md5), record);
  } finally {
    database.close();
  }
});

test('版本 9 图片缓存升级保留旧描述并增加认知元数据列', () => {
  const { directory, file } = tempDatabase();
  let legacy: DatabaseSync | undefined;
  let database: DatabaseSync | undefined;
  try {
    legacy = new DatabaseSync(file);
    legacy.exec(`
      CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL);
      INSERT INTO schema_version (id, version) VALUES (1, 9);
      CREATE TABLE image_captions (key TEXT PRIMARY KEY, caption TEXT NOT NULL, time INTEGER NOT NULL);
      INSERT INTO image_captions VALUES ('legacy-key', '[图片：旧缓存]', 77);
    `);
    legacy.close();
    legacy = undefined;

    database = openDatabase(file);
    const retained = database.prepare('SELECT caption, time FROM image_captions WHERE key = ?')
      .get('legacy-key') as { caption: string; time: number };
    const version = database.prepare('SELECT version FROM schema_version WHERE id = 1')
      .get() as { version: number };
    const columns = database.prepare("PRAGMA table_info('image_captions')")
      .all() as Array<{ name: string }>;

    assert.equal(version.version, 13);
    assert.equal(retained.caption, '[图片：旧缓存]');
    assert.equal(retained.time, 77);
    assert.ok(columns.some(({ name }) => name === 'md5'));
    assert.ok(columns.some(({ name }) => name === 'vision_model'));
    assert.ok(columns.some(({ name }) => name === 'vision_template_version'));
  } finally {
    if (legacy?.isOpen) legacy.close();
    if (database?.isOpen) database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
