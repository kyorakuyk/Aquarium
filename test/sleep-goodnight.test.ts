import assert from 'node:assert/strict';
import test from 'node:test';
import { AquariumConfigSchema } from '../src/config/schema.ts';
import { sessionId, type SessionKey } from '../src/core/shared/events.ts';
import { createMessagePipeline } from '../src/core/conversation/pipeline.ts';
import { createSleepGoodnightScheduler } from '../src/core/sleep/goodnight.ts';
import { createRepository } from '../src/store/repository.ts';
import { FakeAdapter, groupSession, makeConfig, withRepository } from './pipeline-test-helpers.ts';

function at(hour: number, minute = 0): number {
  return new Date(2026, 9, 18, hour, minute).getTime();
}

function sleepConfig() {
  return AquariumConfigSchema.parse({
    ...makeConfig(),
    sleep: { enabled: true, bedtime: '22:00', wake: '07:00', wakeWords: ['醒醒'], goodnight: true },
  });
}

function saveSelfMessage(repository: ReturnType<typeof createRepository>, session: SessionKey, time: number) {
  repository.saveMessage({
    sessionId: sessionId(session),
    messageId: `self-${session.peer}`,
    senderId: session.account,
    senderName: 'Aquarium',
    isSelf: true,
    plainText: '之前的回复',
    segments: [],
    time,
  });
}

function createScheduler(
  repository: ReturnType<typeof createRepository>,
  adapter: FakeAdapter,
  config: ReturnType<typeof sleepConfig>,
  now: () => number,
  sendGoodnight: (session: SessionKey, text: string, cycleKey: string) => Promise<boolean>,
) {
  return createSleepGoodnightScheduler({
    getConfig: () => config,
    adapters: () => [adapter],
    repository,
    getGoodnightLines: () => ['晚安，先去休息了。', '大家晚安。'],
    sendGoodnight,
    now,
    random: () => 0,
  });
}

test('入睡转变只发送一次晚安，按最近 bot 发言最多选两个会话', async () => {
  await withRepository(async (repository) => {
    const adapter = new FakeAdapter();
    const groups = [
      { groupId: 101, name: '较旧', memberCount: 3 },
      { groupId: 102, name: '较新', memberCount: 4 },
      { groupId: 103, name: '最新', memberCount: 5 },
    ];
    adapter.listGroups = async () => groups;
    const sessions = groups.map((group) => ({ account: adapter.account, kind: 'group' as const, peer: group.groupId }));
    saveSelfMessage(repository, sessions[0]!, at(21, 10));
    saveSelfMessage(repository, sessions[1]!, at(21, 20));
    saveSelfMessage(repository, sessions[2]!, at(21, 30));
    let now = at(21, 59);
    const config = sleepConfig();
    let modelCalls = 0;
    const pipeline = createMessagePipeline({
      getConfig: () => config,
      repository,
      adapter,
      getNickname: () => adapter.nickname,
      now: () => now,
      wait: async () => {},
      callModel: async () => {
        modelCalls += 1;
        return {
          text: 'unexpected model reply', provider: 'fake', model: 'fake',
          usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, costCny: 0 },
        };
      },
    });
    const scheduler = createScheduler(
      repository,
      adapter,
      config,
      () => now,
      (session, text, cycleKey) => pipeline.sendSystemReply(session, text, cycleKey),
    );

    await scheduler.tick();
    now = at(22);
    await scheduler.tick();
    await scheduler.tick();

    assert.deepEqual(adapter.sent.map((entry) => entry.session.peer), [103, 102]);
    assert.ok(adapter.sent.every((entry) => entry.segments.length === 1 && entry.segments[0]?.type === 'text'));
    assert.equal(modelCalls, 0);
    const goodnightDecisions = repository.recentDecisions(10).filter((decision) => decision.reason === 'goodnight');
    assert.equal(goodnightDecisions.length, 2);
    assert.ok(goodnightDecisions.every((decision) => (decision.detail as { cycleKey?: string }).cycleKey === '2026-10-18'));
  });
});

test('闭嘴时不发送晚安', async () => {
  await withRepository(async (repository) => {
    const adapter = new FakeAdapter();
    adapter.listGroups = async () => [{ groupId: 101, name: '静音群', memberCount: 3 }];
    const session = { account: adapter.account, kind: 'group' as const, peer: 101 };
    saveSelfMessage(repository, session, at(21, 30));
    let now = at(21, 59);
    const config = sleepConfig();
    const pipeline = createMessagePipeline({
      getConfig: () => config,
      repository,
      adapter,
      getNickname: () => adapter.nickname,
      now: () => now,
      isMuted: () => true,
      wait: async () => {},
      callModel: async () => { throw new Error('goodnight must not call the model'); },
    });
    const scheduler = createScheduler(
      repository,
      adapter,
      config,
      () => now,
      (target, text, cycleKey) => pipeline.sendSystemReply(target, text, cycleKey),
    );

    await scheduler.tick();
    now = at(22);
    await scheduler.tick();
    assert.deepEqual(adapter.sent, []);
    assert.deepEqual(repository.recentDecisions(10), []);
  });
});

test('定时晚安沿用会话频率限制', async () => {
  await withRepository(async (repository, personaRoot) => {
    const adapter = new FakeAdapter();
    const config = sleepConfig();
    const pipeline = createMessagePipeline({
      getConfig: () => config,
      repository,
      adapter,
      getNickname: () => adapter.nickname,
      personaRoot,
      now: () => at(22),
      wait: async () => {},
      callModel: async () => { throw new Error('goodnight must not call the model'); },
    });

    assert.equal(await pipeline.sendSystemReply(groupSession, '大家晚安。', '2026-10-18'), true);
    assert.equal(await pipeline.sendSystemReply(groupSession, '大家晚安。', '2026-10-18'), false);
    assert.equal(adapter.sent.length, 1);
  });
});

test('启动时已经睡着不补发晚安', async () => {
  await withRepository(async (repository) => {
    const adapter = new FakeAdapter();
    adapter.listGroups = async () => [{ groupId: 101, name: '已睡群', memberCount: 3 }];
    const session = { account: adapter.account, kind: 'group' as const, peer: 101 };
    saveSelfMessage(repository, session, at(21, 30));
    let now = at(23);
    const config = sleepConfig();
    const scheduler = createScheduler(repository, adapter, config, () => now, async () => true);

    await scheduler.tick();
    now += 60_000;
    await scheduler.tick();
    assert.deepEqual(repository.recentDecisions(10), []);
  });
});
