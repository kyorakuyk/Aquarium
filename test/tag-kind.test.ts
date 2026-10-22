import assert from 'node:assert/strict';
import test from 'node:test';
import type { TagRecord } from '../src/store/affect-repo.ts';
import { buildImpressionsPromptBlocks } from '../src/core/impressions/prompt-blocks.ts';
import { promptTemplateStore } from '../src/core/prompt/templates.ts';
import { sessionId, type SessionKey } from '../src/core/shared/events.ts';
import { createRepository } from '../src/store/repository.ts';
import { openDatabase } from '../src/store/db.ts';

const account = 91001;
const groupId = 92002;
const userId = 93003;
const now = Date.UTC(2026, 9, 21, 12);
const session: SessionKey = { account, kind: 'group', peer: groupId };

function insertTag(
  repository: ReturnType<typeof createRepository>,
  input: { category: TagRecord['category']; userId: number | null; text: string; polarity?: TagRecord['polarity'] },
): number {
  return repository.insertTag({
    account,
    sessionId: sessionId(session),
    userId: input.userId,
    text: input.text,
    norm: input.text,
    category: input.category,
    subject: null,
    polarity: input.polarity ?? null,
    origin: 'inferred',
    locked: false,
    status: 'confirmed',
    source: 'auto',
    samples: 1,
    evidence: [],
    firstSeen: now,
    lastSeen: now,
    supersededBy: null,
    updatedAt: now,
  });
}

test('标签写入与分类变更都按类别及 polarity 保存 kind', () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database, () => new Date(now));
    const memberCategories = new Set<TagRecord['category']>([
      'identity', 'personality', 'fandom', 'speech', 'catchphrase', 'social', 'dislike',
    ]);
    const cases: Array<[TagRecord['category'], 'fact' | 'view']> = [
      ['positioning', 'fact'], ['topic', 'fact'], ['norms', 'fact'], ['meme', 'fact'],
      ['recent', 'fact'], ['schedule', 'fact'], ['identity', 'fact'], ['fandom', 'fact'],
      ['catchphrase', 'fact'], ['atmosphere', 'view'], ['personality', 'view'], ['speech', 'view'],
      ['social', 'view'], ['dislike', 'view'], ['misc', 'view'],
    ];

    for (const [index, [category, expectedKind]] of cases.entries()) {
      const id = insertTag(repository, {
        category,
        userId: memberCategories.has(category) ? userId : null,
        text: `分类${index}`,
      });
      assert.equal(repository.tagById(id)?.kind, expectedKind, category);
    }

    const polarityId = insertTag(repository, {
      category: 'identity', userId, text: '带偏好的旧标签', polarity: 'like',
    });
    assert.equal(repository.tagById(polarityId)?.kind, 'view');

    const updatedId = insertTag(repository, { category: 'atmosphere', userId: null, text: '分类更新' });
    repository.updateTag(updatedId, { category: 'positioning' });
    assert.equal(repository.tagById(updatedId)?.kind, 'fact');
    repository.updateTag(updatedId, { polarity: 'dislike' });
    assert.equal(repository.tagById(updatedId)?.kind, 'view');
  } finally {
    database.close();
  }
});

test('实际提示词只注入 fact 标签，不注入 view 或带 polarity 的标签', () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database, () => new Date(now));
    const key = sessionId(session);
    insertTag(repository, { category: 'positioning', userId: null, text: '群内规则' });
    insertTag(repository, { category: 'atmosphere', userId: null, text: '气氛热烈' });
    insertTag(repository, { category: 'identity', userId, text: 'INTP' });
    insertTag(repository, { category: 'personality', userId, text: '慢热' });
    insertTag(repository, { category: 'fandom', userId, text: '偏爱猫', polarity: 'like' });
    repository.setAccountKind(account, userId, 'bot', now);

    const blocks = buildImpressionsPromptBlocks(repository, {
      session,
      sessionId: key,
      senderId: userId,
      senderName: '测试账号',
      now,
      template: promptTemplateStore.get().replySystem,
    });

    assert.match(blocks.groupTags ?? '', /群内规则/u);
    assert.doesNotMatch(blocks.groupTags ?? '', /气氛热烈/u);
    assert.match(blocks.memberTags ?? '', /INTP/u);
    assert.doesNotMatch(blocks.memberTags ?? '', /慢热|偏爱猫/u);
  } finally {
    database.close();
  }
});

test('没有 fact 标签时仍保留机器人的身份标记', () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database, () => new Date(now));
    const key = sessionId(session);
    insertTag(repository, { category: 'personality', userId, text: '慢热' });
    repository.setAccountKind(account, userId, 'bot', now);

    const blocks = buildImpressionsPromptBlocks(repository, {
      session,
      sessionId: key,
      senderId: userId,
      senderName: '小明',
      now,
      template: promptTemplateStore.get().replySystem,
    });

    assert.match(blocks.memberTags ?? '', /小明（bot）/u);
    assert.doesNotMatch(blocks.memberTags ?? '', /慢热/u);
  } finally {
    database.close();
  }
});
