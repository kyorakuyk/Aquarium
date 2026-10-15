import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import yaml from 'yaml';
import { AquariumConfigSchema } from '../src/config/schema.ts';
import { sessionId, type IncomingMessage, type Segment, type SessionKey } from '../src/core/events.ts';
import { createIdleBackoff } from '../src/core/activity/backoff.ts';
import { createActivityThreshold } from '../src/core/activity/threshold.ts';
import { createMessagePipeline } from '../src/core/pipeline.ts';
import { promptTemplateStore } from '../src/core/prompt-templates.ts';
import type { ProtocolAdapter } from '../src/adapters/types.ts';
import { openDatabase } from '../src/store/db.ts';
import { createRepository } from '../src/store/repository.ts';

import {
  baseTime,
  createHarness,
  createProactiveHarness,
  FakeAdapter,
  groupSession,
  makeConfig,
  makeIncoming,
  withRepository,
} from './pipeline-test-helpers.ts';

test('active mode runs p0, judge, dynamic threshold, reply, and records safe decision/trace details', async () => {
  await withRepository(async (repository, personaRoot) => {
    const sessionKey = sessionId(groupSession);
    const config = AquariumConfigSchema.parse({
      ...makeConfig({
        nicknames: [],
        sessions: { [sessionKey]: { mode: 'active' } },
      }),
      debug: { enabled: true, sessions: {}, retainDays: 7 },
    });
    const adapter = new FakeAdapter();
    const modelSlots: string[] = [];
    const templates = promptTemplateStore.get();
    const versionedTemplates = {
      ...templates,
      judge: { ...templates.judge, version: 'judge-test-version' },
      vision: { ...templates.vision, version: 'vision-test-version' },
      replySystem: { ...templates.replySystem, version: 'reply-test-version' },
    };
    const pipeline = createMessagePipeline({
      getConfig: () => config,
      repository,
      adapter,
      getNickname: () => adapter.nickname,
      personaRoot,
      callModel: async (slot) => {
        modelSlots.push(slot);
        return {
          text: slot === 'judge'
            ? '{"probability":0.9,"reason":"question"}'
            : slot === 'vision' ? '桌上有一盘菜。' : '可以一起看看。',
          provider: 'fake',
          model: 'fake-model',
          usage: { inputTokens: 8, cachedTokens: 0, outputTokens: 3, costCny: 0 },
        };
      },
      getPromptTemplates: () => versionedTemplates,
      now: () => baseTime,
      wait: async () => {},
    });

    const incoming = makeIncoming({
      messageId: 'active-proactive',
      plainText: '今晚吃什么？',
      time: baseTime - 1_000,
    });
    incoming.segments = [
      { type: 'text', text: '今晚吃什么？' },
      { type: 'image', url: 'data:image/png;base64,AQID', file: 'active-image' },
    ];
    const result = await pipeline(incoming);

    assert.deepEqual(result, { replied: true, reason: 'replied' });
    assert.deepEqual(modelSlots, ['judge', 'vision', 'reply']);
    const decision = repository.recentDecisions(1)[0];
    assert.equal(decision?.reason, 'replied');
    assert.equal(decision?.replied, true);
    const detail = decision?.detail as {
      trigger?: string;
      p0?: number;
      probability?: number;
      threshold?: number;
      promptFingerprints?: Array<{ slot: string; templateVersion: string }>;
    };
    assert.equal(detail.trigger, 'proactive');
    assert.ok(typeof detail.p0 === 'number' && detail.p0 >= 0.15);
    assert.equal(detail.probability, 0.9);
    assert.equal(detail.threshold, 0.35);
    assert.deepEqual(detail.promptFingerprints?.map(({ slot, templateVersion }) => [slot, templateVersion]), [
      ['judge', 'judge-test-version'],
      ['vision', 'vision-test-version'],
      ['reply', 'reply-test-version'],
    ]);
    assert.equal(repository.getCaption('active-image'), '桌上有一盘菜。');

    const traceRecord = repository.pipelineTraceFor(sessionKey, 'active-proactive');
    const trace = (traceRecord?.trace ?? []) as Array<{ step: string; summary: string }>;
    const gateSummary = trace.find(({ step }) => step === 'gate')?.summary ?? '';
    assert.match(gateSummary, /p0=/);
    assert.match(gateSummary, /probability=0\.9/);
    assert.match(gateSummary, /threshold=0\.35/);
    assert.match(gateSummary, /backoff=clear/);
    assert.doesNotMatch(JSON.stringify(trace), /今晚吃什么/);
  });
});

test('budget gate stops proactive judging before the judge slot', async () => {
  await withRepository(async (repository, personaRoot) => {
    const harness = createProactiveHarness(repository, personaRoot, { dailyBudget: 0.001 });
    repository.recordUsage({
      time: Date.now(), slot: 'reply', provider: 'fake', model: 'fake-model',
      inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0.001, latencyMs: 1, ok: true,
    });

    const result = await harness.pipeline(makeIncoming({
      messageId: 'proactive-budget', plainText: '今晚吃什么？', time: baseTime - 1_000,
    }));

    assert.equal(result.reason, 'budget');
    assert.deepEqual(harness.modelSlots, []);
    assert.equal(repository.recentDecisions(1)[0]?.reason, 'budget');
    assert.equal((repository.recentDecisions(1)[0]?.detail as { trigger?: string }).trigger, 'proactive');
  });
});

test('messages folded into a batch are persisted with batched reason without judging', async () => {
  await withRepository(async (repository, personaRoot) => {
    const harness = createProactiveHarness(repository, personaRoot);

    const result = await harness.pipeline(makeIncoming({
      messageId: 'proactive-batched', plainText: '普通群聊内容', time: baseTime - 1_000,
    }), { batched: true });

    assert.equal(result.reason, 'batched');
    assert.deepEqual(harness.modelSlots, []);
    assert.equal(repository.messageBySessionAndId(harness.key, 'proactive-batched')?.plainText, '普通群聊内容');
    assert.equal(repository.recentDecisions(1)[0]?.reason, 'batched');
  });
});

test('idle backoff blocks the second no-reply proactive judgment', async () => {
  await withRepository(async (repository, personaRoot) => {
    const idleBackoff = createIdleBackoff();
    const key = sessionId(groupSession);
    idleBackoff.recordNoReply(key, baseTime - 2_000);
    idleBackoff.recordNoReply(key, baseTime - 1_000);
    const harness = createProactiveHarness(repository, personaRoot, { idleBackoff });

    const result = await harness.pipeline(makeIncoming({
      messageId: 'proactive-backoff', plainText: '今晚吃什么？', time: baseTime - 500,
    }));

    assert.equal(result.reason, 'backoff');
    assert.deepEqual(harness.modelSlots, []);
    assert.equal((repository.recentDecisions(1)[0]?.detail as { backoff?: string }).backoff, 'waiting');
  });
});

test('p0 prefilter skips a cold message addressed to another member', async () => {
  await withRepository(async (repository, personaRoot) => {
    const harness = createProactiveHarness(repository, personaRoot);
    repository.saveMessage({
      sessionId: harness.key,
      messageId: 'old-conversation',
      senderId: 42,
      senderName: 'Friend',
      isSelf: false,
      plainText: 'yesterday',
      segments: [{ type: 'text', text: 'yesterday' }],
      time: baseTime - 21 * 60_000,
    });
    const incoming = makeIncoming({
      messageId: 'proactive-prefilter',
      plainText: '普通内容',
      time: baseTime - 1_000,
    });
    incoming.segments = [
      { type: 'at', target: 99 },
      { type: 'text', text: '普通内容' },
    ];

    const result = await harness.pipeline(incoming);

    assert.equal(result.reason, 'prefilter');
    assert.deepEqual(harness.modelSlots, []);
    const detail = repository.recentDecisions(1)[0]?.detail as { p0?: number };
    assert.ok(typeof detail.p0 === 'number' && detail.p0 < 0.15);
  });
});

test('judge parse and call failures have distinct reasons, never leak error text, and count toward backoff', async () => {
  const scenarios = [
    { reason: 'judge_parse_error', judgeText: 'not-json' },
    { reason: 'judge_error', judgeError: new Error('private-judge-error-canary') },
  ] as const;

  for (const [index, scenario] of scenarios.entries()) {
    await withRepository(async (repository, personaRoot) => {
      const idleBackoff = createIdleBackoff();
      const key = sessionId(groupSession);
      idleBackoff.recordNoReply(key, baseTime - 1_000);
      const harness = createProactiveHarness(repository, personaRoot, {
        ...scenario,
        idleBackoff,
      });

      const result = await harness.pipeline(makeIncoming({
        messageId: `proactive-judge-failure-${index}`,
        plainText: '今晚吃什么？',
        time: baseTime - 500,
      }));

      assert.equal(result.reason, scenario.reason);
      assert.deepEqual(harness.modelSlots, ['judge']);
      const decision = repository.recentDecisions(1)[0];
      assert.equal(decision?.reason, scenario.reason);
      assert.doesNotMatch(JSON.stringify(decision?.detail), /private-judge-error-canary/);
      assert.equal(idleBackoff.shouldBackoff(key, baseTime + 1, 1), true);
      if (scenario.reason === 'judge_error') assert.equal(harness.onErrors.length, 1);
    });
  }
});

test('judge_skip records a no-reply result and the current adaptive threshold', async () => {
  await withRepository(async (repository, personaRoot) => {
    const idleBackoff = createIdleBackoff();
    const key = sessionId(groupSession);
    idleBackoff.recordNoReply(key, baseTime - 1_000);
    const harness = createProactiveHarness(repository, personaRoot, {
      judgeText: '{"probability":0.1,"reason":"low"}',
      idleBackoff,
    });

    const result = await harness.pipeline(makeIncoming({
      messageId: 'proactive-judge-skip', plainText: '今晚吃什么？', time: baseTime - 500,
    }));

    assert.equal(result.reason, 'judge_skip');
    assert.deepEqual(harness.modelSlots, ['judge']);
    const detail = repository.recentDecisions(1)[0]?.detail as {
      probability?: number; threshold?: number; p0?: number;
    };
    assert.equal(detail.probability, 0.1);
    assert.equal(detail.threshold, 0.35);
    assert.ok(typeof detail.p0 === 'number');
    assert.equal(idleBackoff.shouldBackoff(key, baseTime + 1, 1), true);
  });
});

test('current proactive decision uses the threshold captured before judgment history updates', async () => {
  await withRepository(async (repository, personaRoot) => {
    const activityThreshold = createActivityThreshold();
    const key = sessionId(groupSession);
    for (let index = 0; index < 3; index += 1) {
      activityThreshold.recordProactiveReply(key, 'natural', baseTime - (5 - index) * 60_000);
    }
    for (let index = 0; index < 3; index += 1) {
      activityThreshold.recordJudgment(key, 'natural', 0.9, baseTime - (3 - index) * 30_000);
    }
    const harness = createProactiveHarness(repository, personaRoot, {
      mode: 'natural',
      activityThreshold,
      judgeText: '{"probability":0.52,"reason":"borderline"}',
    });

    const result = await harness.pipeline(makeIncoming({
      messageId: 'proactive-current-threshold', plainText: '今晚吃什么？', time: baseTime - 500,
    }));

    assert.equal(result.reason, 'replied');
    assert.deepEqual(harness.modelSlots, ['judge', 'reply']);
    const detail = repository.recentDecisions(1)[0]?.detail as { probability?: number; threshold?: number };
    assert.equal(detail.probability, 0.52);
    assert.equal(detail.threshold, 0.5);
    assert.equal(activityThreshold.getThreshold(key, 'natural', baseTime), 0.55);
  });
});

test('proactive cooldown is a hard per-session cap after judging and threshold comparison', async () => {
  await withRepository(async (repository, personaRoot) => {
    const activityThreshold = createActivityThreshold();
    const key = sessionId(groupSession);
    activityThreshold.recordProactiveReply(key, 'active', baseTime - 60_000);
    const harness = createProactiveHarness(repository, personaRoot, { activityThreshold });

    const result = await harness.pipeline(makeIncoming({
      messageId: 'proactive-cooldown', plainText: '今晚吃什么？', time: baseTime - 500,
    }));

    assert.equal(result.reason, 'proactive_cooldown');
    assert.deepEqual(harness.modelSlots, ['judge']);
    const detail = repository.recentDecisions(1)[0]?.detail as {
      p0?: number; probability?: number; threshold?: number;
    };
    assert.ok(typeof detail.p0 === 'number');
    assert.equal(detail.probability, 0.9);
    assert.equal(detail.threshold, 0.35);
  });
});

test('proactive decisions retain the existing per-user rate limit and any successful reply clears backoff', async () => {
  await withRepository(async (repository, personaRoot) => {
    let now = baseTime;
    const idleBackoff = createIdleBackoff();
    const key = sessionId(groupSession);
    idleBackoff.recordNoReply(key, baseTime - 2_000);
    idleBackoff.recordNoReply(key, baseTime - 1_000);
    const harness = createProactiveHarness(repository, personaRoot, {
      idleBackoff,
      now: () => now,
      rate: { perUserPerMinute: 1, perSessionPerMinute: 5, minIntervalSec: 0.001 },
    });

    const called = await harness.pipeline(makeIncoming({
      messageId: 'called-before-proactive', plainText: 'hello', mentionsSelf: true,
    }));
    now += 10;
    const proactive = await harness.pipeline(makeIncoming({
      messageId: 'proactive-rate-limited', plainText: '今晚吃什么？', time: now - 500,
    }));

    assert.equal(called.reason, 'replied');
    assert.equal(proactive.reason, 'rate_limited');
    assert.deepEqual(harness.modelSlots, ['reply', 'judge']);
    assert.equal(idleBackoff.shouldBackoff(key, now + 1, 1), false);
  });
});

test('a six-message activity batch bypasses idle backoff and reaches judge', async () => {
  await withRepository(async (repository, personaRoot) => {
    const idleBackoff = createIdleBackoff();
    const key = sessionId(groupSession);
    idleBackoff.recordNoReply(key, baseTime - 2_000);
    idleBackoff.recordNoReply(key, baseTime - 1_000);
    const harness = createProactiveHarness(repository, personaRoot, { idleBackoff });
    const messages = Array.from({ length: 6 }, (_, index) => makeIncoming({
      messageId: `proactive-batch-${index}`,
      plainText: index === 5 ? '今晚吃什么？' : `群聊消息 ${index}`,
      time: baseTime - (6 - index) * 1_000,
    }));
    const batch = {
      sessionId: key,
      messages: messages as [IncomingMessage, ...IncomingMessage[]],
      latestMessage: messages[5] as IncomingMessage,
      startedAt: baseTime - 6_000,
      deadlineAt: baseTime,
    };

    const result = await harness.pipeline(messages[5] as IncomingMessage, { activityBatch: batch });

    assert.equal(result.reason, 'replied');
    assert.deepEqual(harness.modelSlots, ['judge', 'reply']);
    assert.equal((repository.recentDecisions(1)[0]?.detail as { backoff?: string }).backoff, 'bypassed');
  });
});
