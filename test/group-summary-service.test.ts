import assert from 'node:assert/strict';
import test from 'node:test';
import { createGroupSummaryService } from '../src/core/impressions/group-summary.ts';
import { promptTemplateStore } from '../src/core/prompt/templates.ts';
import { createRepository } from '../src/store/repository.ts';
import { openDatabase } from '../src/store/db.ts';
import type { TagRecord } from '../src/store/affect-repo.ts';
import { groupSession, makeConfig } from './pipeline-test-helpers.ts';

const account = groupSession.account;
const groupId = `${account}:group:${groupSession.peer}`;
const now = 1_800_000_000_000;

function groupTag(text: string, category: TagRecord['category'], overrides: Partial<TagRecord> = {}): TagRecord {
  return {
    account,
    sessionId: groupId,
    userId: null,
    text,
    norm: text,
    category,
    subject: null,
    polarity: null,
    origin: 'inferred',
    locked: false,
    status: 'confirmed',
    source: 'auto',
    samples: 2,
    evidence: [],
    firstSeen: now,
    lastSeen: now,
    supersededBy: null,
    updatedAt: now,
    ...overrides,
  };
}

function setupDatabase() {
  const database = openDatabase(':memory:');
  return { database, repository: createRepository(database) };
}

test('group summary uses extract and three confirmed unlocked group tags', async () => {
  const { database, repository } = setupDatabase();
  try {
    repository.insertTag(groupTag('游戏', 'positioning'));
    repository.insertTag(groupTag('CS2', 'topic', { subject: '游戏' }));
    repository.insertTag(groupTag('晚间活跃 sk-abc123def456ghi789', 'schedule', { origin: 'stats' }));
    repository.insertTag(groupTag('锁定话题', 'atmosphere', { locked: true }));
    repository.insertTag(groupTag('待确认', 'norms', { status: 'candidate' }));
    const calls: Array<{ slot: string; prompt: string }> = [];
    const service = createGroupSummaryService({
      repository,
      getConfig: makeConfig,
      getTemplate: () => promptTemplateStore.get().memberSummary,
      callModel: async (slot, messages) => {
        calls.push({ slot, prompt: JSON.stringify(messages) });
        return {
          text: '群里常在晚间聚在一起讨论游戏。',
          provider: 'fake',
          model: 'fake-extract',
          usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
        };
      },
      now: () => now,
    });

    service.maybeGenerate(account, groupId, now);
    await service.idle();

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.slot, 'extract');
    assert.ok(calls[0]?.prompt.includes('已确认的群画像标签：'));
    assert.ok(calls[0]?.prompt.includes('游戏'));
    assert.ok(calls[0]?.prompt.includes('CS2'));
    assert.ok(calls[0]?.prompt.includes('晚间活跃'));
    assert.equal(calls[0]?.prompt.includes('sk-abc123def456ghi789'), false);
    assert.equal(calls[0]?.prompt.includes('锁定话题'), false);
    assert.equal(calls[0]?.prompt.includes('待确认'), false);
    assert.deepEqual(repository.getGroupSummary(account, groupId), {
      account,
      sessionId: groupId,
      text: '群里常在晚间聚在一起讨论游戏。',
      manual: false,
      updatedAt: now,
    });
  } finally {
    database.close();
  }
});

test('group summary waits for three changed tags and preserves manual text', async () => {
  const { database, repository } = setupDatabase();
  try {
    repository.saveManualGroupSummary({ account, sessionId: groupId, text: '主人手写的摘要。', updatedAt: now - 10 });
    repository.insertTag(groupTag('标签甲', 'positioning'));
    repository.insertTag(groupTag('标签乙', 'atmosphere'));
    repository.insertTag(groupTag('标签丙', 'norms', { updatedAt: now - 10 }));
    const calls: string[] = [];
    const service = createGroupSummaryService({
      repository,
      getConfig: makeConfig,
      getTemplate: () => promptTemplateStore.get().memberSummary,
      callModel: async (slot) => {
        calls.push(slot);
        return {
          text: '自动摘要不应覆盖。',
          provider: 'fake',
          model: 'fake-extract',
          usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
        };
      },
      now: () => now,
    });

    service.maybeGenerate(account, groupId, now);
    await service.idle();

    assert.deepEqual(calls, []);
    assert.equal(repository.getGroupSummary(account, groupId)?.text, '主人手写的摘要。');
  } finally {
    database.close();
  }
});
