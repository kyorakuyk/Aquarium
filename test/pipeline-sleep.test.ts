import assert from 'node:assert/strict';
import test from 'node:test';
import { AquariumConfigSchema } from '../src/config/schema.ts';
import { sessionId } from '../src/core/shared/events.ts';
import { createMessagePipeline } from '../src/core/conversation/pipeline.ts';
import { openDatabase } from '../src/store/db.ts';
import { createRepository } from '../src/store/repository.ts';
import { FakeAdapter, groupSession, makeConfig, makeIncoming, withRepository } from './pipeline-test-helpers.ts';

function sleepConfig(owner = 999) {
  return AquariumConfigSchema.parse({
    ...makeConfig(),
    owner,
    sleep: { enabled: true, bedtime: '22:00', wake: '07:00', wakeWords: ['醒醒'], goodnight: false },
  });
}

function createSleepHarness(
  repository: ReturnType<typeof createRepository>,
  personaRoot: string,
  config: ReturnType<typeof sleepConfig>,
  now: () => number,
) {
  const adapter = new FakeAdapter();
  const modelSlots: string[] = [];
  let replyPrompt = '';
  const pipeline = createMessagePipeline({
    getConfig: () => config,
    repository,
    adapter,
    getNickname: () => adapter.nickname,
    personaRoot,
    now,
    wait: async () => {},
    callModel: async (slot, messages) => {
      modelSlots.push(slot);
      if (slot === 'reply') {
        replyPrompt = messages.map((message) => typeof message.content === 'string' ? message.content : '').join('\n');
      }
      return {
        text: '收到。',
        provider: 'fake',
        model: 'fake-model',
        usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
      };
    },
  });
  return { adapter, modelSlots, pipeline, replyPrompt: () => replyPrompt };
}

const sleepTime = () => new Date(2026, 9, 18, 23).getTime();

function createEnergyHarness(
  repository: ReturnType<typeof createRepository>,
  personaRoot: string,
  now: number,
  nicknames: string[],
  judgeText: string,
) {
  const key = sessionId(groupSession);
  const config = AquariumConfigSchema.parse({
    ...makeConfig({ nicknames, sessions: { [key]: { mode: 'active' } } }),
    sleep: { enabled: true, bedtime: '22:00', wake: '07:00', wakeWords: ['醒醒'], goodnight: true },
  });
  const adapter = new FakeAdapter();
  const modelSlots: string[] = [];
  let replyPrompt = '';
  const pipeline = createMessagePipeline({
    getConfig: () => config,
    repository,
    adapter,
    getNickname: () => adapter.nickname,
    personaRoot,
    now: () => now,
    wait: async () => {},
    callModel: async (slot, messages) => {
      modelSlots.push(slot);
      if (slot === 'reply') {
        replyPrompt = messages.map((message) => typeof message.content === 'string' ? message.content : '').join('\n');
      }
      return {
        text: slot === 'judge' ? judgeText : '收到。',
        provider: 'fake',
        model: 'fake-model',
        usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
      };
    },
  });
  return { modelSlots, pipeline, replyPrompt: () => replyPrompt };
}

function recordRecentReply(repository: ReturnType<typeof createRepository>, now: number): void {
  repository.recordDecision({
    time: now - 30 * 60_000,
    sessionId: sessionId(groupSession),
    messageId: `prior-reply-${now}`,
    replied: true,
    reason: 'replied',
    detail: {},
  });
}

test('睡着时被叫也不回，但消息照常落库', async () => {
  await withRepository(async (repository, personaRoot) => {
    const harness = createSleepHarness(repository, personaRoot, sleepConfig(), sleepTime);
    const result = await harness.pipeline(makeIncoming({ messageId: 'sleep-blocked', mentionsSelf: true }));

    assert.deepEqual(result, { replied: false, reason: 'asleep' });
    assert.deepEqual(harness.modelSlots, []);
    assert.equal(repository.recentMessages(sessionId(groupSession), 10).length, 1);
  });
});

test('主人叫醒后延长 30 分钟；非主人不能启动或刷新醒来状态', async () => {
  await withRepository(async (repository, personaRoot) => {
    let now = new Date(2026, 9, 19, 6, 59).getTime();
    const baseConfig = sleepConfig();
    const config = AquariumConfigSchema.parse({
      ...baseConfig,
      sleep: { ...baseConfig.sleep, wake: '10:00' },
    });
    const harness = createSleepHarness(repository, personaRoot, config, () => now);
    const groupId = sessionId(groupSession);
    const bedAt = new Date(2026, 9, 18, 22).getTime();
    for (let index = 0; index < 25; index += 1) {
      repository.saveMessage({
        sessionId: groupId,
        messageId: `sleep-history-${index}`,
        senderId: 42,
        senderName: '群友',
        isSelf: false,
        plainText: `睡眠历史${index}`,
        segments: [],
        time: bedAt + (index + 1) * 20 * 60_000,
      });
    }
    const ownerWake = await harness.pipeline(makeIncoming({
      messageId: 'owner-wake', senderId: config.owner, plainText: '醒醒', mentionsSelf: false, time: now,
    }));
    assert.equal(ownerWake.replied, true);
    assert.match(harness.replyPrompt(), /睡眠历史5/u);
    assert.match(harness.replyPrompt(), /睡眠历史24/u);
    assert.doesNotMatch(harness.replyPrompt(), /睡眠历史4/u);
    assert.match(harness.replyPrompt(), /唤醒词附近的睡眠消息.*不可信/u);

    now += 20 * 60_000;
    const ownerFollowup = await harness.pipeline(makeIncoming({
      messageId: 'owner-followup', senderId: config.owner, plainText: '我还没睡。',
    }));
    assert.equal(ownerFollowup.reason, 'mode_mention_only');

    now += 20 * 60_000;
    const withinExtendedWindow = await harness.pipeline(makeIncoming({
      messageId: 'within-extended-window', senderId: 42, plainText: '小鱼，你醒着吗？', mentionsSelf: true,
    }));
    assert.equal(withinExtendedWindow.replied, true);

    now += 10 * 60_000;
    const expired = await harness.pipeline(makeIncoming({
      messageId: 'owner-window-expired', senderId: 42, plainText: '小鱼，醒醒', mentionsSelf: true,
    }));
    assert.deepEqual(expired, { replied: false, reason: 'asleep' });
  });
});

test('睡眠重放跳过睡眠拦截且不创建被叫醒状态', async () => {
  await withRepository(async (repository, personaRoot) => {
    const harness = createSleepHarness(repository, personaRoot, sleepConfig(), sleepTime);
    const message = makeIncoming({ messageId: 'sleep-replay', mentionsSelf: true });
    const replay = await harness.pipeline(message, { replay: true });

    assert.equal(replay.replay?.wouldReply, true);
    assert.deepEqual(harness.adapter.sent, []);
    const live = await harness.pipeline({ ...message, messageId: 'sleep-live' });
    assert.deepEqual(live, { replied: false, reason: 'asleep' });
  });
});

test('低精力在真实 pipeline 提示词中加入困意浮动词', async () => {
  await withRepository(async (repository, personaRoot) => {
    const now = new Date(2026, 9, 18, 21).getTime();
    recordRecentReply(repository, now);
    const harness = createEnergyHarness(repository, personaRoot, now, ['小鱼'], '{"probability":0.9,"reason":"called"}');
    const result = await harness.pipeline(makeIncoming({
      messageId: 'sleep-energy-float', plainText: '小鱼，醒着吗？', time: now - 1_000,
    }));

    assert.equal(result.reason, 'replied');
    assert.deepEqual(harness.modelSlots, ['reply']);
    assert.match(harness.replyPrompt(), /有点困/u);
  });
});

test('低于 0.25 的精力在主动判断阈值上增加 0.1', async () => {
  await withRepository(async (repository, personaRoot) => {
    const now = new Date(2026, 9, 18, 21, 45).getTime();
    recordRecentReply(repository, now);
    const harness = createEnergyHarness(repository, personaRoot, now, [], '{"probability":0.4,"reason":"question"}');
    const result = await harness.pipeline(makeIncoming({
      messageId: 'sleep-energy-threshold', plainText: '今晚吃什么？', time: now - 1_000,
    }));

    assert.equal(result.reason, 'judge_skip');
    assert.deepEqual(harness.modelSlots, ['judge']);
    const detail = repository.recentDecisions(1)[0]?.detail as { threshold?: number; energy?: number };
    assert.equal(detail.threshold, 0.45);
    assert.ok((detail.energy ?? 1) < 0.25);
  });
});
