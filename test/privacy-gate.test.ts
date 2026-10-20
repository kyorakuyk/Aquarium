import assert from 'node:assert/strict';
import test from 'node:test';
import { AquariumConfigSchema } from '../src/config/schema.ts';
import { sessionId } from '../src/core/shared/events.ts';
import { promptTemplateStore } from '../src/core/prompt/templates.ts';
import { createPrivacyGateService } from '../src/core/privacy/group-gate.ts';
import type { PrivateFactRecord } from '../src/store/privacy-repo.ts';
import { groupSession, makeConfig, withRepository } from './pipeline-test-helpers.ts';

const now = new Date(2026, 9, 20, 11, 0).getTime();
const groupKey = sessionId(groupSession);

function fact(input: {
  ownerId: number;
  text: string;
  keywords?: string[];
  level?: 'L0' | 'L1' | 'L2';
  updatedAt?: number;
}): Omit<PrivateFactRecord, 'id'> {
  return {
    account: groupSession.account,
    ownerId: input.ownerId,
    sessionId: `${groupSession.account}:private:${input.ownerId}`,
    text: input.text,
    keywords: input.keywords ?? ['考研', '压力'],
    level: input.level ?? 'L0',
    levelSource: 'auto',
    mentions: 0,
    mentionEvidence: [],
    evidence: [],
    status: 'active',
    createdAt: input.updatedAt ?? now,
    updatedAt: input.updatedAt ?? now,
  };
}

function saveGroupMessage(
  repository: Parameters<Parameters<typeof withRepository>[0]>[0],
  messageId: string,
  senderId: number,
  plainText: string,
  time = now,
): void {
  repository.saveMessage({
    sessionId: groupKey,
    messageId,
    senderId,
    senderName: `user-${senderId}`,
    isSelf: false,
    plainText,
    segments: [],
    time,
  });
}

function result(text: string) {
  return {
    text,
    provider: 'fake',
    model: 'fake-judge',
    usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
  };
}

test('no keyword hit skips judge and never includes private fact text', async () => {
  await withRepository(async (repository) => {
    const id = repository.insertPrivateFact(fact({ ownerId: 42, text: '最近正在准备考研，感到压力很大' }));
    saveGroupMessage(repository, 'message-1', 42, '今晚一起玩游戏吗？');
    let calls = 0;
    const service = createPrivacyGateService({
      repository,
      getConfig: makeConfig,
      callModel: async () => { calls += 1; throw new Error('must not call'); },
    });

    const decision = await service.evaluateGroup({
      session: groupSession,
      senderId: 50,
      triggered: false,
      now,
      messages: repository.recentMessages(groupKey, 8),
      template: promptTemplateStore.get().privacyGate,
      knownFactsTemplate: promptTemplateStore.get().replySystem.knownFacts,
    });

    assert.equal(calls, 0);
    assert.equal(decision.action, 'allow');
    assert.equal(decision.knownFacts, undefined);
    assert.equal(JSON.stringify(decision.detail).includes(String(id)), false);
    assert.equal(JSON.stringify(decision.detail).includes('最近正在准备考研'), false);
  });
});

test('隐私守门先放固定判断说明，再附上下文和候选事实', async () => {
  await withRepository(async (repository) => {
    repository.insertPrivateFact(fact({ ownerId: 42, text: '正在讨论话题甲', keywords: ['话题甲', '讨论甲'] }));
    repository.insertPrivateFact(fact({ ownerId: 43, text: '正在讨论话题乙', keywords: ['话题乙', '讨论乙'] }));
    saveGroupMessage(repository, 'gate-a', 42, '正在讨论话题甲');
    saveGroupMessage(repository, 'gate-b', 43, '正在讨论话题乙', now + 60_000);
    const prompts: Array<{ system: string; user: string }> = [];
    const service = createPrivacyGateService({
      repository,
      getConfig: makeConfig,
      callModel: async (_slot, messages) => {
        prompts.push({ system: String(messages[0]?.content), user: String(messages[1]?.content) });
        return result(JSON.stringify({ touches: [] }));
      },
    });
    const template = promptTemplateStore.get().privacyGate;
    const knownFactsTemplate = promptTemplateStore.get().replySystem.knownFacts;

    await service.evaluateGroup({
      session: groupSession,
      senderId: 42,
      triggered: true,
      now,
      messages: [repository.messageBySessionAndId(groupKey, 'gate-a')!],
      template,
      knownFactsTemplate,
    });
    await service.evaluateGroup({
      session: groupSession,
      senderId: 43,
      triggered: true,
      now: now + 60_000,
      messages: [repository.messageBySessionAndId(groupKey, 'gate-b')!],
      template,
      knownFactsTemplate,
    });

    assert.equal(prompts.length, 2);
    assert.equal(prompts[0]?.system, prompts[1]?.system);
    const instruction = '请结合上下文判断哪些事实正在被讨论，只返回对应 id。';
    assert.ok(prompts[0]?.user.startsWith(instruction));
    assert.ok(prompts[1]?.user.startsWith(instruction));
    assert.notEqual(prompts[0]?.user, prompts[1]?.user);
  });
});

test('L0 topic hit blocks proactive replies, starts cooldown, and called replies get only the fixed rule', async () => {
  await withRepository(async (repository) => {
    const id = repository.insertPrivateFact(fact({ ownerId: 42, text: '最近正在准备考研，感到压力很大' }));
    saveGroupMessage(repository, 'message-2', 42, '考研准备得怎么样，最近压力大吗？');
    let calls = 0;
    let debugTraceProvided = false;
    const service = createPrivacyGateService({
      repository,
      getConfig: makeConfig,
      callModel: async (_slot, messages, options) => {
        calls += 1;
        debugTraceProvided = options.debugTrace !== undefined;
        assert.ok(String(messages[1]?.content).includes(`#${id} 最近正在准备考研，感到压力很大`));
        return result(JSON.stringify({ touches: [id] }));
      },
    });
    const input = {
      session: groupSession,
      senderId: 50,
      triggered: false,
      now,
      messages: repository.recentMessages(groupKey, 8),
      template: promptTemplateStore.get().privacyGate,
      knownFactsTemplate: promptTemplateStore.get().replySystem.knownFacts,
    };

    const proactive = await service.evaluateGroup(input);
    const earlyCooldown = service.activeAvoid({ session: groupSession, now: now + 1 });
    const repeated = await service.evaluateGroup({ ...input, now: now + 1, messages: [] });
    const called = await service.evaluateGroup({ ...input, triggered: true, senderId: 42, now: now + 2 });

    assert.equal(proactive.action, 'avoid');
    assert.equal(proactive.detail.touched[0]?.id, id);
    assert.equal(proactive.detail.touched[0]?.level, 'L0');
    assert.equal(JSON.stringify(proactive.detail).includes('最近正在准备考研'), false);
    assert.equal(earlyCooldown?.action, 'avoid');
    assert.equal(repeated.action, 'avoid');
    assert.equal(calls, 2);
    assert.equal(debugTraceProvided, false);
    assert.equal(called.action, 'allow');
    assert.equal(called.privateRule, '群里正在聊的话题可能涉及别人的私事。你对此一无所知，不追问、不展开、不猜测。');
    assert.equal(called.knownFacts, undefined);
  });
});

test('L1 and L2 touches plus up to three owner L2 facts form the knownFacts block', async () => {
  await withRepository(async (repository) => {
    const config = AquariumConfigSchema.parse({ ...makeConfig(), owner: 99 });
    const l1 = repository.insertPrivateFact(fact({
      ownerId: 42,
      text: '最近在准备考试',
      keywords: ['考试', '学习'],
      level: 'L1',
      updatedAt: now,
    }));
    const l2 = repository.insertPrivateFact(fact({
      ownerId: 42,
      text: '喜欢爵士钢琴',
      keywords: ['爵士', '钢琴'],
      level: 'L2',
      updatedAt: now - 1,
    }));
    const l2Second = repository.insertPrivateFact(fact({
      ownerId: 42,
      text: '周末常去听音乐会',
      keywords: ['周末', '音乐会'],
      level: 'L2',
      updatedAt: now - 2,
    }));
    const l2Third = repository.insertPrivateFact(fact({
      ownerId: 42,
      text: '正在学吉他',
      keywords: ['学习', '吉他'],
      level: 'L2',
      updatedAt: now - 3,
    }));
    repository.insertPrivateFact(fact({
      ownerId: 42,
      text: '喜欢听现场音乐',
      keywords: ['现场', '音乐'],
      level: 'L2',
      updatedAt: now - 4,
    }));
    saveGroupMessage(repository, 'message-3', 42, '最近考试复习很忙。');
    let calls = 0;
    const service = createPrivacyGateService({
      repository,
      getConfig: () => config,
      callModel: async () => {
        calls += 1;
        return result(JSON.stringify({ touches: [l1] }));
      },
    });

    const decision = await service.evaluateGroup({
      session: groupSession,
      senderId: 42,
      triggered: true,
      now,
      messages: repository.recentMessages(groupKey, 8),
      template: promptTemplateStore.get().privacyGate,
      knownFactsTemplate: promptTemplateStore.get().replySystem.knownFacts,
    });

    assert.equal(calls, 1);
    assert.equal(decision.action, 'allow');
    assert.ok(decision.knownFacts?.includes('最近在准备考试'));
    assert.ok(decision.knownFacts?.includes('喜欢爵士钢琴'));
    assert.ok(decision.knownFacts?.includes('周末常去听音乐会'));
    assert.ok(decision.knownFacts?.includes('正在学吉他'));
    assert.equal(decision.knownFacts?.includes('喜欢听现场音乐'), false);
    assert.deepEqual(decision.detail.injected.map(({ id }) => id), [l1, l2, l2Second, l2Third]);
  });
});

test('judge call or parse failure treats every prefiltered fact as touched', async () => {
  await withRepository(async (repository) => {
    const id = repository.insertPrivateFact(fact({ ownerId: 42, text: '最近正在准备考研，感到压力很大' }));
    saveGroupMessage(repository, 'message-4', 42, '考研准备得怎么样？');
    for (const callModel of [
      async () => { throw new Error('private provider error'); },
      async () => result('invalid JSON'),
    ]) {
      const service = createPrivacyGateService({ repository, getConfig: makeConfig, callModel });
      const decision = await service.evaluateGroup({
        session: groupSession,
        senderId: 50,
        triggered: false,
        now,
        messages: repository.recentMessages(groupKey, 8),
        template: promptTemplateStore.get().privacyGate,
      knownFactsTemplate: promptTemplateStore.get().replySystem.knownFacts,
      });
      assert.equal(decision.action, 'avoid');
      assert.equal(decision.detail.touched[0]?.id, id);
      assert.equal(decision.detail.judge, 'fallback_all');
    }
  });
});

test('egress blocks a group reply containing two L0 keywords and reports only its id', async () => {
  await withRepository(async (repository) => {
    const id = repository.insertPrivateFact(fact({
      ownerId: 42,
      text: '最近正在准备考研，感到压力很大',
      keywords: ['考研', '压力', '备考'],
    }));
    saveGroupMessage(repository, 'message-5', 42, '说点别的');
    const alerts: Array<{ account: number; sessionId: string; factId: number }> = [];
    const service = createPrivacyGateService({
      repository,
      getConfig: makeConfig,
      callModel: async () => result('{"touches":[]}'),
      onEgress: (alert) => alerts.push(alert),
    });

    const blocked = service.checkEgress({ session: groupSession, text: '考研压力很大' });
    const allowed = service.checkEgress({ session: groupSession, text: '今晚考研资料发一下' });

    assert.deepEqual(blocked, { blocked: true, factId: id, level: 'L0' });
    assert.equal(allowed.blocked, false);
    assert.deepEqual(alerts, [{ account: groupSession.account, sessionId: groupKey, factId: id }]);
  });
});
