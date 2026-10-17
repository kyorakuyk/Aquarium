import assert from 'node:assert/strict';
import test from 'node:test';
import { AquariumConfigSchema } from '../src/config/schema.ts';
import { sessionId } from '../src/core/events.ts';
import { createMessagePipeline } from '../src/core/pipeline.ts';
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
  const pipeline = createMessagePipeline({
    getConfig: () => config,
    repository,
    adapter,
    getNickname: () => adapter.nickname,
    personaRoot,
    now,
    wait: async () => {},
    callModel: async (slot) => {
      modelSlots.push(slot);
      return {
        text: '收到。',
        provider: 'fake',
        model: 'fake-model',
        usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
      };
    },
  });
  return { adapter, modelSlots, pipeline };
}

const sleepTime = () => new Date(2026, 9, 18, 23).getTime();

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
    let now = sleepTime();
    const config = sleepConfig();
    const harness = createSleepHarness(repository, personaRoot, config, () => now);
    const ownerWake = await harness.pipeline(makeIncoming({
      messageId: 'owner-wake', senderId: config.owner, plainText: '小鱼，醒醒', mentionsSelf: true,
    }));
    assert.equal(ownerWake.replied, true);

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
