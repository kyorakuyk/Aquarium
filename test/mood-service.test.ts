import assert from 'node:assert/strict';
import test from 'node:test';
import { createAffinityService } from '../src/core/affinity/service.ts';
import { createMoodService } from '../src/core/mood/service.ts';
import { createMessagePipeline } from '../src/core/conversation/pipeline.ts';
import { sessionId } from '../src/core/shared/events.ts';
import {
  FakeAdapter,
  groupSession,
  makeConfig,
  makeIncoming,
  withRepository,
} from './pipeline-test-helpers.ts';

function createMoodHarness(
  repository: Parameters<Parameters<typeof withRepository>[0]>[0],
  config: ReturnType<typeof makeConfig>,
  personaRoot: string,
  options: { appraiseText?: string; appraiseAdvanceMs?: number } = {},
) {
  const adapter = new FakeAdapter();
  const replyPrompts: string[] = [];
  const appraiseRequests: string[] = [];
  const clock = { value: new Date(2026, 9, 12, 9, 0).getTime() };
  const affinityService = createAffinityService({ repository, getConfig: () => config });
  const moodService = createMoodService({
    repository,
    getConfig: () => config,
    affinityService,
    now: () => clock.value,
    callModel: async (_slot, messages) => {
      appraiseRequests.push(messages.map((message) => String(message.content)).join('\n'));
      clock.value += options.appraiseAdvanceMs ?? 0;
      return {
        text: options.appraiseText ?? '{"valence":-0.15,"arousal":0.1,"reason":"被怼了"}',
        provider: 'fake',
        model: 'fake-model',
        usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
      };
    },
  });
  const pipeline = createMessagePipeline({
    getConfig: () => config,
    repository,
    adapter,
    getNickname: () => adapter.nickname,
    personaRoot,
    moodService,
    affinityService,
    callModel: async (_slot, messages) => {
      replyPrompts.push(messages.map((message) => String(message.content)).join('\n'));
      return {
        text: '普通回复。',
        provider: 'fake',
        model: 'fake-model',
        usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
      };
    },
    now: () => clock.value,
    wait: async () => {},
    random: () => 0.4,
  });
  return { adapter, affinityService, appraiseRequests, clock, moodService, pipeline, replyPrompts };
}

test('回复后异步评估并换档，下一次提示词带情绪块', async () => {
  await withRepository(async (repository, personaRoot) => {
    const config = makeConfig();
    const harness = createMoodHarness(repository, config, personaRoot, { appraiseAdvanceMs: 5_000 });
    const account = groupSession.account;
    const fakeCredential = 'K9m4R2p8T1v6';
    repository.saveMoodState({
      account,
      valence: -0.1,
      arousal: 0.75,
      updatedAt: harness.clock.value,
      band: 'calm',
      bandSince: harness.clock.value - 20 * 60_000,
      lastBandChangeAt: harness.clock.value - 20 * 60_000,
    });

    const first = await harness.pipeline(makeIncoming({
      messageId: 'mood-1',
      time: harness.clock.value - 1_000,
    }));
    assert.deepEqual(first, { replied: true, reason: 'replied' });
    await harness.moodService.idle();

    const state = repository.getMoodState(account);
    const decayedValence = 0.1 + (-0.1 - 0.1) * 2 ** (-5_000 / (30 * 60_000));
    const decayedArousal = 0.4 + (0.8 - 0.4) * 2 ** (-5_000 / (30 * 60_000));
    assert.equal(state?.band, 'annoyed');
    assert.ok(Math.abs((state?.valence ?? 0) - (decayedValence - 0.15)) < 1e-9);
    assert.ok(Math.abs((state?.arousal ?? 0) - (decayedArousal + 0.1)) < 1e-9);
    assert.equal(state?.updatedAt, harness.clock.value);

    const events = repository.recentMoodEvents(account, 10);
    assert.deepEqual(events.map((event) => event.source), ['band', 'appraise', 'rule']);
    assert.equal(events[0]?.bandBefore, 'calm');
    assert.equal(events[0]?.bandAfter, 'annoyed');
    assert.equal(events[0]?.time, harness.clock.value);
    assert.equal(events[1]?.reason, '被怼了');
    assert.equal(events[1]?.appliedDv, -0.15);
    assert.equal(events[1]?.time, harness.clock.value);
    assert.equal(events[2]?.reason, 'called');
    assert.equal(events[0]?.valenceAfter, state?.valence);
    assert.equal(events[0]?.arousalAfter, state?.arousal);
    assert.equal(events[1]?.valenceAfter, state?.valence);
    assert.equal(events[1]?.arousalAfter, state?.arousal);
    assert.equal(events[2]?.valenceAfter, -0.1);
    assert.equal(events[2]?.arousalAfter, 0.8);
    assert.ok(harness.appraiseRequests[0]?.includes('普通回复。'));

    harness.clock.value += 100_000;
    config.debug.sessions[sessionId(groupSession)] = true;
    repository.saveAffinityState({
      account,
      userId: 42,
      value: 70,
      level: 'warm',
      levelSince: harness.clock.value - 3_600_000,
      lastLevelChangeAt: harness.clock.value - 3_600_000,
      lastInteractionAt: harness.clock.value,
      updatedAt: harness.clock.value,
    });
    const secondMessage = makeIncoming({
      messageId: 'mood-2',
      time: harness.clock.value - 1_000,
    });
    secondMessage.senderName = `小明 token=${fakeCredential}`;
    const second = await harness.pipeline(secondMessage);
    assert.deepEqual(second, { replied: true, reason: 'replied' });
    await harness.moodService.idle();

    const secondPrompt = harness.replyPrompts[1] ?? '';
    assert.ok(secondPrompt.includes('你现在有点不爽'));
    assert.ok(secondPrompt.includes('很来劲'));
    assert.ok(secondPrompt.includes(`token=${fakeCredential}`));
    const detail = repository.recentDecisions(1)[0]?.detail as {
      promptBlocks?: Array<{ id: string }>;
      injectedAffectBlocks?: { mood?: string; float?: string; affinity?: string };
    };
    assert.deepEqual(detail.promptBlocks?.map((block) => block.id), [
      'persona', 'rules', 'groupNote', 'mood', 'affinity', 'float',
    ]);
    assert.ok(detail.injectedAffectBlocks?.mood?.includes('你现在有点不爽'));
    assert.ok(detail.injectedAffectBlocks?.float?.includes('很来劲'));
    assert.ok(detail.injectedAffectBlocks?.affinity?.includes('小明'));
    assert.equal(JSON.stringify(detail.injectedAffectBlocks).includes(fakeCredential), false);
    assert.ok(detail.injectedAffectBlocks?.affinity?.includes('[敏感内容已隐藏]'));
    const trace = repository.pipelineTraceFor(sessionId(groupSession), 'mood-2');
    const contextTrace = trace?.trace.find((entry) => {
      return typeof entry === 'object' && entry !== null && 'step' in entry && entry.step === 'context';
    }) as { detail?: { injectedAffectBlocks?: unknown } } | undefined;
    assert.deepEqual(contextTrace?.detail?.injectedAffectBlocks, detail.injectedAffectBlocks);
  });
});

test('同一会话的评估至少间隔 90 秒，间隔内不评估也不排队', async () => {
  await withRepository(async (repository, personaRoot) => {
    const config = makeConfig();
    const harness = createMoodHarness(repository, config, personaRoot);

    await harness.pipeline(makeIncoming({ messageId: 'gap-1', time: harness.clock.value - 1_000 }));
    await harness.moodService.idle();
    assert.equal(harness.appraiseRequests.length, 1);

    harness.clock.value += 30_000;
    await harness.pipeline(makeIncoming({ messageId: 'gap-2', time: harness.clock.value - 1_000 }));
    await harness.moodService.idle();
    assert.equal(harness.appraiseRequests.length, 1);

    harness.clock.value += 70_000;
    await harness.pipeline(makeIncoming({ messageId: 'gap-3', time: harness.clock.value - 1_000 }));
    await harness.moodService.idle();
    assert.equal(harness.appraiseRequests.length, 2);
  });
});

test('评估解析失败时记录原因且不改变状态', async () => {
  await withRepository(async (repository, personaRoot) => {
    const config = makeConfig();
    const harness = createMoodHarness(repository, config, personaRoot, {
      appraiseAdvanceMs: 5_000,
      appraiseText: '{"valence":0.5,"arousal":0.2,"reason":"越界"}',
    });

    await harness.pipeline(makeIncoming({ messageId: 'parse-1', time: harness.clock.value - 1_000 }));
    await harness.moodService.idle();

    const state = repository.getMoodState(groupSession.account);
    assert.equal(state?.valence, 0.1);
    assert.equal(state?.arousal, 0.45);
    assert.equal(state?.band, 'calm');
    const events = repository.recentMoodEvents(groupSession.account, 10);
    assert.deepEqual(events.map((event) => event.reason), ['appraise_parse_error', 'called']);
    assert.equal(events[0]?.time, harness.clock.value);
    assert.equal(events.some((event) => event.source === 'band'), false);
  });
});

test('mood.enabled 关闭时评估不调用且提示词没有情绪块', async () => {
  await withRepository(async (repository, personaRoot) => {
    const config = makeConfig({ mood: { enabled: false } });
    const harness = createMoodHarness(repository, config, personaRoot);

    const result = await harness.pipeline(makeIncoming({
      messageId: 'off-1',
      time: harness.clock.value - 1_000,
    }));
    await harness.moodService.idle();

    assert.deepEqual(result, { replied: true, reason: 'replied' });
    assert.equal(harness.appraiseRequests.length, 0);
    assert.equal(repository.getMoodState(groupSession.account), undefined);
    assert.deepEqual(repository.recentMoodEvents(groupSession.account, 10), []);
    const detail = repository.recentDecisions(1)[0]?.detail as { promptBlocks?: Array<{ id: string }> };
    assert.deepEqual(detail.promptBlocks?.map((block) => block.id), ['persona', 'rules', 'groupNote']);
  });
});

test('情绪评估更新发送者好感，下一次提示词按顺序注入 affinity 块', async () => {
  await withRepository(async (repository, personaRoot) => {
    const config = makeConfig({ affinity: { enabled: true, initial: 50 } });
    const harness = createMoodHarness(repository, config, personaRoot, {
      appraiseText: '{"valence":0.15,"arousal":0,"reason":"友好回应"}',
    });
    const account = groupSession.account;
    repository.saveAffinityState({
      account,
      userId: 42,
      value: 62,
      level: 'neutral',
      levelSince: harness.clock.value - 10 * 24 * 60 * 60 * 1000,
      lastLevelChangeAt: harness.clock.value - 10 * 24 * 60 * 60 * 1000,
      lastInteractionAt: harness.clock.value - 1_000,
      updatedAt: harness.clock.value - 1_000,
    });

    await harness.pipeline(makeIncoming({ messageId: 'affinity-1', mentionsSelf: true }));
    await harness.moodService.idle();

    const updated = repository.getAffinityState(account, 42);
    assert.equal(updated?.value, 65.5);
    assert.equal(updated?.level, 'warm');
    assert.ok(repository.recentAffinityEvents(account, 42, 10).some((event) => event.source === 'appraise' && event.applied === 3));

    harness.clock.value += 100_000;
    await harness.pipeline(makeIncoming({ messageId: 'affinity-2', mentionsSelf: true }));
    const secondPrompt = harness.replyPrompts[1] ?? '';
    assert.ok(secondPrompt.includes('你和"小明"挺熟'));
    const nextDetail = repository.recentDecisions(1)[0]?.detail as { promptBlocks?: Array<{ id: string }> };
    assert.deepEqual(nextDetail.promptBlocks?.map((block) => block.id), ['persona', 'rules', 'groupNote', 'mood', 'affinity']);
  });
});

test('affinity.enabled=false 时完全不记录好感且不注入提示词', async () => {
  await withRepository(async (repository, personaRoot) => {
    const config = makeConfig({ affinity: { enabled: false, initial: 50 } });
    const harness = createMoodHarness(repository, config, personaRoot, {
      appraiseText: '{"valence":0.15,"arousal":0,"reason":"友好回应"}',
    });

    await harness.pipeline(makeIncoming({ messageId: 'affinity-off', mentionsSelf: true }));
    await harness.moodService.idle();

    assert.equal(repository.listAffinityStates(groupSession.account).length, 0);
    assert.deepEqual(repository.recentAffinityEvents(groupSession.account, 42, 10), []);
    assert.equal(harness.replyPrompts[0]?.includes('挺熟'), false);
  });
});
