import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../src/store/db.ts';
import { createRepository } from '../src/store/repository.ts';
import { createTagSubjectRepository } from '../src/store/tag-subject-repo.ts';
import { createTagClassificationRepository } from '../src/store/tag-classification-repo.ts';
import type { TagRecord } from '../src/store/tag-repo.ts';

const account = 7;
const sessionId = '7:group:8';
const at = 1_800_000_000_000;

function insertTag(
  repository: ReturnType<typeof createRepository>,
  overrides: Partial<TagRecord> = {},
): number {
  const tag: TagRecord = {
    account,
    sessionId,
    userId: 42,
    text: '旧标签',
    norm: '旧标签',
    category: 'misc',
    subject: null,
    polarity: null,
    origin: 'inferred',
    locked: false,
    status: 'candidate',
    source: 'auto',
    samples: 1,
    evidence: [],
    firstSeen: at - 1_000,
    lastSeen: at - 1_000,
    supersededBy: null,
    updatedAt: at - 1_000,
    ...overrides,
  };
  return repository.insertTag(tag);
}

test('分类仓储只列出未锁定的未整理标签，并持久保存完成标记', () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    const classifications = createTagClassificationRepository(database);
    const eligible = insertTag(repository);
    insertTag(repository, { text: '锁定旧标签', norm: '锁定旧标签', locked: true });
    insertTag(repository, { text: '已合并标签', norm: '已合并标签', status: 'superseded', supersededBy: 1 });
    insertTag(repository, { text: '已分类标签', norm: '已分类标签', category: 'personality' });

    assert.deepEqual(classifications.listUnlockedMiscTags().map(({ id }) => id), [eligible]);
    assert.equal(classifications.countLockedMiscTags(), 1);
    assert.equal(classifications.isLegacyMiscClassificationComplete(), false);
    classifications.markLegacyMiscClassificationComplete(at);
    assert.equal(createTagClassificationRepository(database).isLegacyMiscClassificationComplete(), true);
  } finally {
    database.close();
  }
});

test('合并同义标签时累计 samples/evidence 并保留手动标签优先级', () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    const subjects = createTagSubjectRepository(database);
    subjects.saveTagSubject({ account, category: 'fandom', name: '守望先锋', aliases: ['OW'] });
    const targetId = insertTag(repository, {
      text: '守望先锋玩家',
      norm: '守望先锋玩家',
      category: 'fandom',
      subject: '守望先锋',
      polarity: 'like',
      status: 'candidate',
      samples: 3,
      evidence: [{ messageId: 'target-evidence', time: at - 2_000, quote: '我玩守望先锋' }],
    });
    const sourceId = insertTag(repository, {
      text: '喜欢OW',
      norm: '喜欢ow',
      status: 'confirmed',
      source: 'manual',
      origin: 'manual',
      samples: 2,
      evidence: [{ messageId: 'source-evidence', time: at - 1_000, quote: '最近喜欢OW' }],
    });
    const classifications = createTagClassificationRepository(database);

    assert.equal(classifications.mergeMiscTag({
      sourceId,
      targetId,
      profile: { category: 'fandom', subject: 'OW', polarity: 'like' },
      at,
    }), true);

    const target = repository.tagById(targetId);
    const source = repository.tagById(sourceId);
    assert.equal(target?.samples, 5);
    assert.deepEqual(target?.evidence.map(({ messageId }) => messageId), ['target-evidence', 'source-evidence']);
    assert.equal(target?.lastSeen, at - 1_000);
    assert.equal(target?.status, 'confirmed');
    assert.equal(target?.source, 'manual');
    assert.equal(target?.origin, 'manual');
    assert.equal(source?.category, 'fandom');
    assert.equal(source?.subject, '守望先锋');
    assert.equal(source?.status, 'superseded');
    assert.equal(source?.supersededBy, targetId);
  } finally {
    database.close();
  }
});

test('norm 相同的标签不能被合并', () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    const targetId = insertTag(repository, {
      text: '旧标签', norm: '旧标签', category: 'personality', subject: null, polarity: null,
    });
    const sourceId = insertTag(repository, { text: '旧标签', norm: '旧标签' });
    const classifications = createTagClassificationRepository(database);

    assert.equal(classifications.mergeMiscTag({
      sourceId,
      targetId,
      profile: { category: 'personality', subject: null, polarity: null },
      at,
    }), false);
    assert.equal(repository.tagById(sourceId)?.status, 'candidate');
    assert.equal(repository.tagById(sourceId)?.category, 'misc');
  } finally {
    database.close();
  }
});
