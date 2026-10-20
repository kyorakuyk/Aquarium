import assert from 'node:assert/strict';
import test from 'node:test';
import { promptTemplateStore } from '../src/core/prompt-templates.ts';
import { createPrivateFactsService, type PrivateFactsSummary } from '../src/core/privacy/service.ts';
import type { PrivateFactRecord } from '../src/store/privacy-repo.ts';
import { AquariumConfigSchema } from '../src/config/schema.ts';
import { groupSession, makeConfig, withRepository } from './pipeline-test-helpers.ts';

const ownerId = 42;
const session = { account: groupSession.account, kind: 'private' as const, peer: ownerId };
const key = `${session.account}:private:${ownerId}`;
const now = new Date(2026, 9, 20, 9, 0).getTime();

function fact(patch: Partial<Omit<PrivateFactRecord, 'id'>> = {}): Omit<PrivateFactRecord, 'id'> {
  return {
    account: session.account,
    ownerId,
    sessionId: key,
    text: '正在准备考研',
    keywords: ['考研', '复习'],
    level: 'L0',
    levelSource: 'auto',
    mentions: 0,
    mentionEvidence: [],
    evidence: [{ messageId: 'seed-message', time: now - 10_000, quote: '开始准备考研' }],
    status: 'active',
    createdAt: now - 10_000,
    updatedAt: now - 10_000,
    ...patch,
  };
}

async function savePrivateMessage(
  repository: Parameters<Parameters<typeof withRepository>[0]>[0],
  options: { messageId: string; time: number; senderId?: number; isSelf?: boolean; plainText?: string },
): Promise<void> {
  repository.saveMessage({
    sessionId: key,
    messageId: options.messageId,
    senderId: options.senderId ?? ownerId,
    senderName: options.isSelf ? '眷属' : '小明',
    isSelf: options.isSelf ?? false,
    plainText: options.plainText ?? '最近在准备考研，压力有点大。',
    segments: [],
    time: options.time,
  });
}

test('private extraction is thresholded, validates evidence, updates facts, and advances its cursor', async () => {
  await withRepository(async (repository) => {
    const currentId = repository.insertPrivateFact(fact());
    const obsoleteId = repository.insertPrivateFact(fact({ text: '已完成搬家', keywords: ['搬家', '完成'] }));
    const otherSessionId = repository.insertPrivateFact(fact({
      sessionId: `${session.account}:private:other`,
      text: '其他私聊里的秘密',
      keywords: ['其他', '秘密'],
    }));
    repository.insertPrivateFact(fact({
      ownerId: 43,
      text: '别人准备换工作',
      keywords: ['换工作', '计划'],
    }));
    repository.savePrivacyRun({
      account: session.account,
      sessionId: key,
      lastRunAt: now - 6 * 60 * 60 * 1_000,
      lastMessageTime: now - 60 * 60 * 1_000,
    });
    const messageTimes = Array.from({ length: 5 }, (_, index) => now - (5 - index) * 60_000);
    for (let index = 0; index < messageTimes.length; index += 1) {
      await savePrivateMessage(repository, {
        messageId: `owner-${index + 1}`,
        time: messageTimes[index]!,
        plainText: index === 4 ? '已经开始每周末爬山。' : '继续准备考试。',
      });
    }
    await savePrivateMessage(repository, {
      messageId: 'bot-message',
      time: now - 10_000,
      senderId: session.account,
      isSelf: true,
      plainText: '你可以试试周末爬山。',
    });
    const summaries: PrivateFactsSummary[] = [];
    const requests: Array<{ slot: string; content: string }> = [];
    const config = makeConfig();
    const service = createPrivateFactsService({
      repository,
      getConfig: () => config,
      onExtract: (summary) => summaries.push(summary),
      callModel: async (slot, messages) => {
        requests.push({ slot, content: String(messages[1]?.content) });
        return {
          text: JSON.stringify({
            new: [
              { text: '喜欢周末爬山', keywords: ['周末', '爬山'], messageId: 'owner-5' },
              { text: '无效的 bot 推断', keywords: ['bot', '推断'], messageId: 'bot-message' },
              { text: '正在准备考研', keywords: ['考研', '复习'], messageId: 'owner-5' },
            ],
            update: [
              { id: currentId, text: '开始每周末徒步', keywords: ['周末', '徒步'], messageId: 'owner-5' },
              { id: 999_999, text: '无效 ID 更新', keywords: ['无效', '更新'], messageId: 'owner-5' },
            ],
            obsolete: [{ id: obsoleteId }, { id: 999_999 }],
          }),
          provider: 'fake',
          model: 'fake-extract',
          usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
        };
      },
    });

    service.maybeExtract({
      session,
      messageId: 'owner-5',
      senderId: ownerId,
      now,
      template: promptTemplateStore.get().extractPrivate,
    });
    await service.idle();

    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.slot, 'extract');
    assert.ok(requests[0]?.content.includes(`#${currentId} 正在准备考研`));
    assert.equal(requests[0]?.content.includes('其他私聊里的秘密'), false);
    assert.equal(requests[0]?.content.includes('别人准备换工作'), false);
    assert.equal(requests[0]?.content.includes('QQ 42'), false);
    const active = repository.listPrivateFactsForOwner(session.account, ownerId)
      .filter(({ sessionId }) => sessionId === key);
    assert.deepEqual(active.map(({ id, text }) => [id, text]).sort((a, b) => Number(a[0]) - Number(b[0])), [
      [currentId, '开始每周末徒步'],
      [repository.listPrivateFactsForOwner(session.account, ownerId).find(({ text }) => text === '喜欢周末爬山')?.id, '喜欢周末爬山'],
    ]);
    assert.equal(repository.privateFactById(currentId)?.level, 'L0');
    assert.equal(repository.privateFactById(currentId)?.evidence.at(-1)?.messageId, 'owner-5');
    assert.equal(repository.privateFactById(obsoleteId)?.status, 'deleted');
    assert.equal(repository.privateFactById(otherSessionId)?.status, 'active');
    assert.deepEqual(summaries[0], {
      account: session.account,
      sessionId: key,
      status: 'done',
      inserted: 1,
      updated: 1,
      deleted: 1,
      dropped: 4,
    });
    assert.deepEqual(repository.getPrivacyRun(session.account, key), {
      account: session.account,
      sessionId: key,
      lastRunAt: now,
      lastMessageTime: now - 60_000,
    });
  });
});

test('privacy extraction ignores disabled feature and budget-exceeded accounts', async () => {
  await withRepository(async (repository) => {
    for (let index = 0; index < 5; index += 1) {
      await savePrivateMessage(repository, { messageId: `disabled-${index}`, time: now - 1_000 + index });
    }
    let calls = 0;
    const base = makeConfig();
    const disabled = AquariumConfigSchema.parse({ ...base, privacy: { ...base.privacy, enabled: false } });
    const service = createPrivateFactsService({
      repository,
      getConfig: () => disabled,
      callModel: async () => { calls += 1; throw new Error('must not call'); },
    });

    service.maybeExtract({ session, messageId: 'disabled-4', senderId: ownerId, now, template: promptTemplateStore.get().extractPrivate });
    await service.idle();
    assert.equal(calls, 0);
    assert.equal(repository.getPrivacyRun(session.account, key), undefined);

    const overBudget = AquariumConfigSchema.parse({
      ...base,
      budget: { ...base.budget, dailyCny: 0 },
    });
    const blockedService = createPrivateFactsService({
      repository,
      getConfig: () => overBudget,
      callModel: async () => { calls += 1; throw new Error('must not call'); },
    });
    blockedService.maybeExtract({ session, messageId: 'disabled-4', senderId: ownerId, now, template: promptTemplateStore.get().extractPrivate });
    await blockedService.idle();
    assert.equal(calls, 0);
  });
});

test('20 incoming messages after 30 minutes trigger one serialized extraction per session', async () => {
  await withRepository(async (repository) => {
    repository.savePrivacyRun({
      account: session.account,
      sessionId: key,
      lastRunAt: now - 30 * 60 * 1_000,
      lastMessageTime: now - 30 * 60 * 1_000,
    });
    for (let index = 0; index < 19; index += 1) {
      await savePrivateMessage(repository, {
        messageId: `batch-${index + 1}`,
        time: now - 10 * 60 * 1_000 + index * 30_000,
      });
    }
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    let release!: () => void;
    let markStarted!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const service = createPrivateFactsService({
      repository,
      getConfig: makeConfig,
      callModel: async () => {
        calls += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        markStarted();
        await gate;
        active -= 1;
        return {
          text: '{"new":[],"update":[],"obsolete":[]}',
          provider: 'fake',
          model: 'fake-extract',
          usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
        };
      },
    });

    service.maybeExtract({
      session,
      messageId: 'batch-19',
      senderId: ownerId,
      now,
      template: promptTemplateStore.get().extractPrivate,
    });
    assert.equal(calls, 0);
    await savePrivateMessage(repository, { messageId: 'batch-20', time: now - 5_000 });
    service.maybeExtract({
      session,
      messageId: 'batch-20',
      senderId: ownerId,
      now,
      template: promptTemplateStore.get().extractPrivate,
    });
    await started;
    await savePrivateMessage(repository, { messageId: 'batch-21', time: now - 1_000 });
    service.maybeExtract({
      session,
      messageId: 'batch-21',
      senderId: ownerId,
      now,
      template: promptTemplateStore.get().extractPrivate,
    });
    release();
    await service.idle();

    assert.equal(calls, 1);
    assert.equal(maxActive, 1);
  });
});

test('malformed extraction output still advances the privacy run cursor', async () => {
  await withRepository(async (repository) => {
    repository.savePrivacyRun({
      account: session.account,
      sessionId: key,
      lastRunAt: now - 6 * 60 * 60 * 1_000,
      lastMessageTime: now - 60 * 60 * 1_000,
    });
    for (let index = 0; index < 5; index += 1) {
      await savePrivateMessage(repository, { messageId: `bad-${index + 1}`, time: now - (5 - index) * 60_000 });
    }
    const summaries: PrivateFactsSummary[] = [];
    const service = createPrivateFactsService({
      repository,
      getConfig: makeConfig,
      onExtract: (summary) => summaries.push(summary),
      callModel: async () => ({
        text: 'not JSON',
        provider: 'fake',
        model: 'fake-extract',
        usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
      }),
    });

    service.maybeExtract({
      session,
      messageId: 'bad-5',
      senderId: ownerId,
      now,
      template: promptTemplateStore.get().extractPrivate,
    });
    await service.idle();

    assert.equal(summaries[0]?.status, 'parse_error');
    assert.deepEqual(repository.getPrivacyRun(session.account, key), {
      account: session.account,
      sessionId: key,
      lastRunAt: now,
      lastMessageTime: now - 60_000,
    });
    assert.equal(repository.listPrivateFactsForOwner(session.account, ownerId).length, 0);
  });
});
