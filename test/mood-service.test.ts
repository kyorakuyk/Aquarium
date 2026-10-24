import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createAffinityService } from '../src/core/affinity/service.ts';
import { createMoodService } from '../src/core/mood/service.ts';
import { createMessagePipeline } from '../src/core/conversation/pipeline.ts';
import { promptTemplateStore } from '../src/core/prompt/templates.ts';
import { sessionId } from '../src/core/shared/events.ts';
import { loadPersona } from '../src/persona/load.ts';
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
  const affinityService = createAffinityService({
    repository,
    getConfig: () => config,
    getPersonaAffinity: (personaId) => loadPersona(personaId, '', { root: personaRoot }).affinity,
  });
  const moodService = createMoodService({
    repository,
    getConfig: () => config,
    affinityService,
    now: () => clock.value,
    callModel: async (_slot, messages) => {
      appraiseRequests.push(messages.map((message) => String(message.content)).join('\n'));
      clock.value += options.appraiseAdvanceMs ?? 0;
      return {
        text: options.appraiseText ?? '{"valence":-0.15,"reserve":0,"arousal":0.1,"reason":"被怼了"}',
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
      valence: -0.15,
      arousal: 0.75,
      updatedAt: harness.clock.value,
      band: 'calm',
      bandSince: harness.clock.value - 20 * 60_000,
      lastBandChangeAt: harness.clock.value - 20 * 60_000,
      reserve: 0.8,
      reserveBand: 'full',
      reserveBandSince: null,
      reserveLastChangeAt: null,
      lastReplyAt: null,
    });

    const first = await harness.pipeline(makeIncoming({
      messageId: 'mood-1',
      time: harness.clock.value - 1_000,
    }));
    assert.deepEqual(first, { replied: true, reason: 'replied' });
    await harness.moodService.idle();

    const state = repository.getMoodState(account);
    const decayMs = 5_000;
    const surfaceHalfLife = 40 * 1.4 / (0.4 + 0.8);
    const decayedValence = 0.1 + (-0.15 - 0.1) * 2 ** (-decayMs / (surfaceHalfLife * 60_000));
    const decayedArousal = 0.4 + (0.75 + (1 - 0.75) * 0.05 - 0.4) * 2 ** (-decayMs / (40 * 60_000));
    const absorption = Math.min(0.15 * 0.85 * Math.min(1, 0.8 / 0.5), 0.05);
    const expectedValence = decayedValence - 0.15 + absorption;
    const expectedArousal = decayedArousal + 0.1 * (1 - decayedArousal);
    const expectedReserve = 0.8 - Math.max(0, decayedValence + 0.15) * 0.3 - absorption * 1.5;
    assert.equal(state?.band, 'annoyed');
    assert.ok(Math.abs((state?.valence ?? 0) - expectedValence) < 1e-9);
    assert.ok(Math.abs((state?.arousal ?? 0) - expectedArousal) < 1e-9);
    assert.ok(Math.abs((state?.reserve ?? 0) - expectedReserve) < 1e-9);
    assert.equal(state?.updatedAt, harness.clock.value);

    const events = repository.recentMoodEvents(account, 10);
    assert.deepEqual(events.map((event) => event.source), ['band', 'appraise', 'rule']);
    assert.equal(events[0]?.bandBefore, 'calm');
    assert.equal(events[0]?.bandAfter, 'annoyed');
    assert.equal(events[0]?.time, harness.clock.value);
    assert.equal(events[1]?.reason, '被怼了');
    assert.equal(events[1]?.appliedDv, -0.15);
    assert.equal(events[1]?.absorbed, absorption);
    assert.equal(events[1]?.reserveAfter, expectedReserve);
    assert.equal(events[1]?.time, harness.clock.value);
    assert.equal(events[2]?.reason, 'called');
    assert.equal(events[0]?.valenceAfter, state?.valence);
    assert.equal(events[0]?.arousalAfter, state?.arousal);
    assert.equal(events[1]?.valenceAfter, state?.valence);
    assert.equal(events[1]?.arousalAfter, state?.arousal);
    assert.equal(events[2]?.valenceAfter, -0.15);
    assert.equal(events[2]?.arousalAfter, 0.75 + (1 - 0.75) * 0.05);
    assert.ok(harness.appraiseRequests[0]?.includes('普通回复。'));

    harness.clock.value += 100_000;
    config.debug.sessions[sessionId(groupSession)] = true;
    repository.saveAffinityState({
      account,
      userId: 42,
      value: 70,
      level: 'more_than_friends',
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
      appraiseText: '{"valence":0.5,"reserve":0,"arousal":0.2,"reason":"越界"}',
    });

    await harness.pipeline(makeIncoming({ messageId: 'parse-1', time: harness.clock.value - 1_000 }));
    await harness.moodService.idle();

    const state = repository.getMoodState(groupSession.account);
    assert.equal(state?.valence, 0.1);
    assert.ok(Math.abs((state?.arousal ?? 0) - 0.43) < 1e-9);
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
    assert.deepEqual(detail.promptBlocks?.map((block) => block.id), ['persona', 'rules', 'groupNote', 'affinity']);
  });
});

test('情绪评估更新发送者好感，下一次提示词按顺序注入 affinity 块', async () => {
  await withRepository(async (repository, personaRoot) => {
    fs.writeFileSync(path.join(personaRoot, 'personas', 'default.md'), [
      '---',
      'affinity:',
      '  mode: independent',
      '  curves:',
      '    posGain:',
      '      preset: flat',
      '      points:',
      '        - x: 0.15',
      '          dy: 0.5',
      '---',
      '# {{name}}',
      '测试人设。',
    ].join('\n'), 'utf8');
    const config = makeConfig({ affinity: { enabled: true, start: 15 } });
    const harness = createMoodHarness(repository, config, personaRoot, {
      appraiseText: '{"valence":0.15,"reserve":0,"arousal":0,"reason":"友好回应"}',
    });
    const account = groupSession.account;
    repository.saveAffinityState({
      account,
      userId: 42,
      value: 62,
      level: 'more_than_friends',
      levelSince: harness.clock.value - 10 * 24 * 60 * 60 * 1000,
      lastLevelChangeAt: harness.clock.value - 10 * 24 * 60 * 60 * 1000,
      lastInteractionAt: harness.clock.value - 1_000,
      updatedAt: harness.clock.value - 1_000,
    });

    await harness.pipeline(makeIncoming({ messageId: 'affinity-1', mentionsSelf: true }));
    await harness.moodService.idle();

    const updated = repository.getPersonaAffinityState(account, 42, 'default');
    assert.equal(updated?.value, 20);
    assert.equal(updated?.level, 'acquaintance');
    assert.equal(repository.getAffinityState(account, 42)?.value, 62);
    assert.equal(repository.getPersonaAffinityState(account + 1, 42, 'default'), undefined);
    const affinityEvents = repository.recentPersonaAffinityEvents(account, 42, 'default', 10);
    assert.ok(affinityEvents.some((event) => event.source === 'called' && event.applied === 0.75));
    assert.ok(affinityEvents.some((event) => event.source === 'appraise'
      && Math.abs(event.delta - 4.495) < 1e-9 && event.applied === 4.25));

    harness.clock.value += 100_000;
    await harness.pipeline(makeIncoming({ messageId: 'affinity-2', mentionsSelf: true }));
    const secondPrompt = harness.replyPrompts[1] ?? '';
    assert.ok(secondPrompt.includes('你和"小明"已经熟悉'));
    const nextDetail = repository.recentDecisions(1)[0]?.detail as { promptBlocks?: Array<{ id: string }> };
    assert.deepEqual(nextDetail.promptBlocks?.map((block) => block.id), ['persona', 'rules', 'groupNote', 'mood', 'affinity']);

    await harness.moodService.idle();
    const independentValue = repository.getPersonaAffinityState(account, 42, 'default')?.value;
    fs.writeFileSync(path.join(personaRoot, 'personas', 'default.md'), [
      '---', 'affinity:', '  mode: inherit', '---', '# {{name}}', '测试人设。',
    ].join('\n'), 'utf8');
    assert.equal(harness.affinityService.getCurrent(account, 42, harness.clock.value).value, 62);
    assert.equal(repository.getPersonaAffinityState(account, 42, 'default')?.value, independentValue);
  });
});

test('affinity.enabled=false 时完全不记录好感且不注入提示词', async () => {
  await withRepository(async (repository, personaRoot) => {
    const config = makeConfig({ affinity: { enabled: false, start: 15 } });
    const harness = createMoodHarness(repository, config, personaRoot, {
      appraiseText: '{"valence":0.15,"reserve":0,"arousal":0,"reason":"友好回应"}',
    });

    await harness.pipeline(makeIncoming({ messageId: 'affinity-off', mentionsSelf: true }));
    await harness.moodService.idle();

    assert.equal(repository.listAffinityStates(groupSession.account).length, 0);
    assert.deepEqual(repository.recentAffinityEvents(groupSession.account, 42, 10), []);
    assert.equal(harness.replyPrompts[0]?.includes('挺熟'), false);
  });
});

test('outer 正向评估额外补充一半 valence 到心灵能量', async () => {
  await withRepository(async (repository) => {
    const config = makeConfig();
    const start = new Date(2026, 9, 12, 9, 0).getTime();
    repository.saveMoodState({
      account: groupSession.account,
      valence: config.mood.baseline.valence,
      arousal: config.mood.baseline.arousal,
      updatedAt: start,
      band: 'calm',
      bandSince: start - 30 * 60_000,
      lastBandChangeAt: start - 30 * 60_000,
      reserve: 0.5,
      reserveBand: 'tired',
      reserveBandSince: start - 30 * 60_000,
      reserveLastChangeAt: start - 30 * 60_000,
      lastReplyAt: null,
    });
    const mood = createMoodService({
      repository,
      getConfig: () => config,
      now: () => start,
      callModel: async () => ({
        text: '{"valence":0.1,"reserve":0,"arousal":0,"reason":"被关心"}',
        provider: 'fake',
        model: 'fake-model',
        usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
      }),
    });

    await mood.afterReply({
      account: groupSession.account,
      sessionId: sessionId(groupSession),
      senderId: 42,
      now: start,
      template: promptTemplateStore.get().appraise,
      energySource: 'outer',
    });

    assert.equal(repository.getMoodState(groupSession.account)?.reserve, 0.55);
    assert.equal(repository.recentMoodEvents(groupSession.account, 10).find((event) => event.source === 'appraise')?.appliedDr, 0.05);
  });
});

test('inner 连续回复逐条消耗心灵能量且陪伴不回能', async () => {
  await withRepository(async (repository) => {
    const config = makeConfig();
    const start = new Date(2026, 9, 12, 9, 0).getTime();
    const mood = createMoodService({
      repository,
      getConfig: () => config,
      now: () => start,
      callModel: async () => ({
        text: '{"valence":0,"reserve":0,"arousal":0,"reason":"日常"}',
        provider: 'fake',
        model: 'fake-model',
        usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
      }),
    });
    const account = groupSession.account;
    const session = sessionId(groupSession);

    for (let index = 0; index < 6; index += 1) {
      await mood.afterReply({
        account,
        sessionId: session,
        senderId: 42,
        now: start + index * 10_000,
        template: promptTemplateStore.get().appraise,
        energySource: 'inner',
      });
    }

    const state = repository.getMoodState(account);
    const socialCosts = repository.recentMoodEvents(account, 20).filter((event) => event.reason === 'social_cost');
    assert.ok(Math.abs((state?.reserve ?? 0) - 0.74) < 1e-9);
    assert.equal(socialCosts.length, 6);
  });
});

test('同一会话十分钟内只加一次被叫兴奋度且正向增量饱和', async () => {
  await withRepository(async (repository) => {
    const config = makeConfig();
    const clock = { value: 1_000_000 };
    const mood = createMoodService({ repository, getConfig: () => config, now: () => clock.value });
    const account = groupSession.account;
    const session = sessionId(groupSession);

    for (let index = 0; index < 20; index += 1) {
      clock.value = 1_000_000 + index * 60_000;
      mood.recordCalled({ account, sessionId: session, now: clock.value });
    }

    const state = repository.getMoodState(account);
    const called = repository.recentMoodEvents(account, 30).filter((event) => event.reason === 'called');
    assert.ok((state?.arousal ?? 1) < 1);
    assert.equal(called.length, 2);
  });
});
