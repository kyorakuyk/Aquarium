import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccountActivityRouter } from '../src/app/activity-routing.ts';
import { promptTemplateStore } from '../src/core/prompt-templates.ts';
import { createPrivacyGateService } from '../src/core/privacy/group-gate.ts';
import { sessionId } from '../src/core/events.ts';
import { createSessionQueue } from '../src/core/session-queue.ts';
import type { PrivateFactRecord } from '../src/store/privacy-repo.ts';
import {
  baseTime,
  createProactiveHarness,
  groupSession,
  makeConfig,
  makeIncoming,
  withRepository,
} from './pipeline-test-helpers.ts';

function fact(text: string): Omit<PrivateFactRecord, 'id'> {
  return {
    account: groupSession.account,
    ownerId: 42,
    sessionId: `${groupSession.account}:private:42`,
    text,
    keywords: ['考研', '压力'],
    level: 'L0',
    levelSource: 'auto',
    mentions: 0,
    mentionEvidence: [],
    evidence: [],
    status: 'active',
    createdAt: baseTime,
    updatedAt: baseTime,
  };
}

test('proactive L0 hit is avoided and every later proactive message skips during cooldown', async () => {
  await withRepository(async (repository, personaRoot) => {
    const privateText = '最近在准备考研，承受压力很大';
    const factId = repository.insertPrivateFact(fact(privateText));
    let config: ReturnType<typeof makeConfig> | undefined;
    let now = baseTime;
    let gateCalls = 0;
    const privacyGateService = createPrivacyGateService({
      repository,
      getConfig: () => config ?? makeConfig(),
      callModel: async () => {
        gateCalls += 1;
        return {
          text: JSON.stringify({ touches: [factId] }),
          provider: 'fake',
          model: 'fake-judge',
          usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
        };
      },
    });
    const harness = createProactiveHarness(repository, personaRoot, {
      privacyGateService,
      now: () => now,
    });
    config = harness.config;
    const messages = Array.from({ length: 6 }, (_, index) => makeIncoming({
      messageId: `proactive-privacy-${index}`,
      plainText: index === 5 ? '考研最近有什么计划？' : `群聊消息 ${index}`,
      senderId: 42,
      time: baseTime - (6 - index) * 1_000,
    }));
    const latest = messages[5] as ReturnType<typeof makeIncoming>;
    const batch = {
      sessionId: harness.key,
      messages: messages as [ReturnType<typeof makeIncoming>, ...ReturnType<typeof makeIncoming>[]],
      latestMessage: latest,
      startedAt: baseTime - 6_000,
      deadlineAt: baseTime,
    };

    const first = await harness.pipeline(latest, { activityBatch: batch });
    now += 1;
    const second = await harness.pipeline(makeIncoming({
      messageId: 'proactive-privacy-repeat',
      plainText: '今天天气不错。',
      senderId: 50,
      time: now,
    }));
    const decisions = repository.recentDecisions(2);
    const firstDetail = JSON.stringify(decisions[1]?.detail);
    const secondDetail = JSON.stringify(decisions[0]?.detail);

    assert.deepEqual(first, { replied: false, reason: 'privacy_avoid' });
    assert.deepEqual(second, { replied: false, reason: 'privacy_avoid' });
    assert.equal(gateCalls, 1);
    assert.deepEqual(harness.modelSlots, []);
    assert.deepEqual(harness.adapter.sent, []);
    assert.ok(firstDetail.includes(String(factId)));
    assert.ok(secondDetail.includes(String(factId)));
    assert.equal(firstDetail.includes(privateText), false);
    assert.equal(secondDetail.includes(privateText), false);
  });
});

test('real activity batches keep privacy_avoid for every member during an active cooldown', async () => {
  await withRepository(async (repository, personaRoot) => {
    const privateText = '最近在准备考研，承受压力很大';
    const factId = repository.insertPrivateFact(fact(privateText));
    const groupKey = sessionId(groupSession);
    const seedMessage = {
      sessionId: groupKey,
      messageId: 'privacy-cooldown-seed',
      senderId: 42,
      senderName: '主人',
      isSelf: false,
      plainText: '考研压力',
      segments: [{ type: 'text', text: '考研压力' }],
      time: baseTime - 1_000,
    };
    repository.saveMessage(seedMessage);

    let config = makeConfig();
    let now = baseTime;
    let gateCalls = 0;
    const privacyGateService = createPrivacyGateService({
      repository,
      getConfig: () => config,
      callModel: async () => {
        gateCalls += 1;
        return {
          text: JSON.stringify({ touches: [factId] }),
          provider: 'fake',
          model: 'fake-judge',
          usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
        };
      },
    });
    const harness = createProactiveHarness(repository, personaRoot, {
      privacyGateService,
      now: () => now,
    });
    config = harness.config;
    const templates = promptTemplateStore.get();
    const seededAvoid = await privacyGateService.evaluateGroup({
      session: groupSession,
      senderId: 50,
      triggered: false,
      now,
      messages: [seedMessage],
      template: templates.privacyGate,
      knownFactsTemplate: templates.replySystem.knownFacts,
    });
    assert.equal(seededAvoid.action, 'avoid');

    const queue = createSessionQueue();
    const timers = new Map<number, () => void>();
    let nextTimerId = 0;
    const outcomes: Array<{ messageId: string; reason: string }> = [];
    const router = createAccountActivityRouter({
      now: () => now,
      setTimer(callback) {
        const id = ++nextTimerId;
        timers.set(id, callback);
        return id;
      },
      clearTimer(id) { timers.delete(id); },
      queue,
      getConfig: () => config,
      management: { handle: async () => false, isMuted: () => false },
      costToday: repository.costToday,
      processMessage: async (message, options) => {
        const result = await harness.pipeline(message, options);
        outcomes.push({ messageId: message.messageId, reason: result.reason });
      },
    });

    router.route(makeIncoming({ messageId: 'cooldown-batch-first', plainText: '普通话题一', senderId: 50, time: now }));
    now += 100;
    router.route(makeIncoming({ messageId: 'cooldown-batch-latest', plainText: '普通话题二', senderId: 51, time: now }));
    now += 10_000;
    const flush = [...timers.values()].at(-1);
    assert.ok(flush);
    flush();
    await queue.idle();
    router.close();

    assert.deepEqual(outcomes, [
      { messageId: 'cooldown-batch-first', reason: 'privacy_avoid' },
      { messageId: 'cooldown-batch-latest', reason: 'privacy_avoid' },
    ]);
    assert.equal(gateCalls, 1);
    assert.deepEqual(harness.modelSlots, []);
  });
});
