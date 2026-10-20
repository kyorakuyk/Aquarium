import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemberSummaryService } from '../src/core/impressions/member-summary.ts';
import { promptTemplateStore } from '../src/core/prompt/templates.ts';
import { createRepository, type StoreRepository } from '../src/store/repository.ts';
import { createMemberSummaryRepository } from '../src/store/member-summary-repo.ts';
import { openDatabase } from '../src/store/db.ts';
import type { TagRecord } from '../src/store/affect-repo.ts';
import { makeConfig } from './pipeline-test-helpers.ts';

const account = 900000001;
const userId = 42;
const now = 1_800_000_000_000;

function insertTag(repository: StoreRepository, overrides: Partial<TagRecord> = {}): number {
  return repository.insertTag({
    account,
    sessionId: `${account}:group:123456`,
    userId,
    text: '标签',
    norm: '标签',
    category: 'personality',
    subject: null,
    polarity: null,
    origin: 'inferred',
    locked: false,
    status: 'confirmed',
    source: 'auto',
    samples: 3,
    evidence: [],
    firstSeen: now,
    lastSeen: now,
    supersededBy: null,
    updatedAt: now,
    ...overrides,
  });
}

function fakeModel(text: string, calls: Array<{ slot: string; prompt: string }>) {
  return async (slot: string, messages: Array<{ role: string; content: unknown }>) => {
    calls.push({ slot, prompt: JSON.stringify(messages) });
    return {
      text,
      provider: 'fake',
      model: 'fake-extract',
      usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
    };
  };
}

test('三条 confirmed 画像变化后用 extract 槽位生成且只输入未锁定标签', async () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    const summaries = createMemberSummaryRepository(database);
    insertTag(repository, { text: '慢热', norm: '慢热', category: 'personality' });
    insertTag(repository, { text: '夜猫子', norm: '夜猫子', category: 'schedule' });
    insertTag(repository, {
      text: 'CS2', norm: 'cs2', category: 'fandom', subject: '游戏', polarity: 'like',
    });
    insertTag(repository, { text: '锁定标签', norm: '锁定标签', locked: true });
    insertTag(repository, { text: '待确认标签', norm: '待确认标签', status: 'candidate' });

    const calls: Array<{ slot: string; prompt: string }> = [];
    const service = createMemberSummaryService({
      repository,
      summaryRepository: summaries,
      getConfig: makeConfig,
      getTemplate: () => promptTemplateStore.get().memberSummary,
      callModel: fakeModel('安静细致，喜欢深入交流。', calls),
      now: () => now,
    });
    service.maybeGenerate(account, userId, now);
    await service.idle();

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.slot, 'extract');
    assert.ok(calls[0]?.prompt.includes('慢热'));
    assert.ok(calls[0]?.prompt.includes('夜猫子'));
    assert.ok(calls[0]?.prompt.includes('CS2'));
    assert.equal(calls[0]?.prompt.includes('锁定标签'), false);
    assert.equal(calls[0]?.prompt.includes('待确认标签'), false);
    assert.deepEqual(summaries.get(account, userId), {
      account,
      userId,
      text: '安静细致，喜欢深入交流。',
      manual: false,
      updatedAt: now,
    });
  } finally {
    database.close();
  }
});

test('成员摘要在不同标签输入下保留相同的固定开头', async () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    const summaries = createMemberSummaryRepository(database);
    for (const [targetUserId, texts] of [
      [42, ['慢热', '夜猫子', '喜欢阅读']],
      [43, ['健谈', '喜欢徒步', '常玩桌游']],
    ] as const) {
      for (const text of texts) insertTag(repository, { userId: targetUserId, text, norm: text });
    }
    const requests: Array<Array<{ role: string; content: string }>> = [];
    const service = createMemberSummaryService({
      repository,
      summaryRepository: summaries,
      getConfig: makeConfig,
      getTemplate: () => promptTemplateStore.get().memberSummary,
      callModel: async (_slot, messages) => {
        requests.push(messages.map(({ role, content }) => ({ role, content: String(content) })));
        return {
          text: '平和稳重，兴趣广泛。',
          provider: 'fake',
          model: 'fake-summary',
          usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
        };
      },
      now: () => now,
    });

    service.maybeGenerate(account, 42, now);
    service.maybeGenerate(account, 43, now);
    await service.idle();

    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.[0]?.content, requests[1]?.[0]?.content);
    const fixedPrefix = '已确认的群友画像标签：\n';
    assert.ok(requests[0]?.[1]?.content.startsWith(fixedPrefix));
    assert.ok(requests[1]?.[1]?.content.startsWith(fixedPrefix));
    assert.notEqual(requests[0]?.[1]?.content, requests[1]?.[1]?.content);
  } finally {
    database.close();
  }
});

test('少于三条自上次摘要更新的 confirmed 标签时不调用模型', async () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    const summaries = createMemberSummaryRepository(database);
    summaries.saveGenerated({ account, userId, text: '旧摘要', updatedAt: now - 100 });
    const ids = [
      insertTag(repository, { text: '标签甲', norm: '标签甲', updatedAt: now }),
      insertTag(repository, { text: '标签乙', norm: '标签乙', updatedAt: now }),
      insertTag(repository, { text: '标签丙', norm: '标签丙', updatedAt: now - 100 }),
    ];
    const calls: Array<{ slot: string; prompt: string }> = [];
    const service = createMemberSummaryService({
      repository,
      summaryRepository: summaries,
      getConfig: makeConfig,
      getTemplate: () => promptTemplateStore.get().memberSummary,
      callModel: fakeModel('更新摘要。', calls),
      now: () => now,
    });

    service.maybeGenerate(account, userId, now);
    await service.idle();
    assert.equal(calls.length, 0);

    repository.updateTag(ids[2] as number, { updatedAt: now });
    service.maybeGenerate(account, userId, now);
    await service.idle();
    assert.equal(calls.length, 1);
  } finally {
    database.close();
  }
});

test('manual 摘要不会被自动生成覆盖', async () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    const summaries = createMemberSummaryRepository(database);
    summaries.saveManual({ account, userId, text: '主人写的摘要', updatedAt: now - 10 });
    for (const text of ['甲', '乙', '丙']) insertTag(repository, { text, norm: text });
    const calls: Array<{ slot: string; prompt: string }> = [];
    const service = createMemberSummaryService({
      repository,
      summaryRepository: summaries,
      getConfig: makeConfig,
      getTemplate: () => promptTemplateStore.get().memberSummary,
      callModel: fakeModel('自动摘要。', calls),
      now: () => now,
    });

    service.maybeGenerate(account, userId, now);
    await service.idle();

    assert.equal(calls.length, 0);
    assert.equal(summaries.get(account, userId)?.text, '主人写的摘要');
  } finally {
    database.close();
  }
});
