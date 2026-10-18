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

test('replay uses historical context, counts usage, and performs no live delivery or persistence', async () => {
  await withRepository(async (repository, personaRoot) => {
    const config = AquariumConfigSchema.parse({
      ...makeConfig(),
      debug: { enabled: true, sessions: {}, retainDays: 7 },
    });
    const adapter = new FakeAdapter();
    const targetTime = baseTime - 60_000;
    const session = sessionId(groupSession);
    const save = (messageId: string, plainText: string, time: number) => repository.saveMessage({
      sessionId: session,
      messageId,
      senderId: 42,
      senderName: '小明',
      isSelf: false,
      plainText,
      segments: [{ type: 'text', text: plainText }],
      time,
    });
    save('replay-before', '历史上下文', targetTime - 60_000);
    save('replay-target', '小鱼，请重放这条', targetTime);
    save('replay-after', '未来上下文不得进入提示词', targetTime + 30_000);
    save('replay-late-arrival', '迟到的旧消息不得进入提示词', targetTime - 30_000);
    repository.recordDecision({
      time: targetTime,
      sessionId: session,
      messageId: 'replay-target',
      replied: false,
      reason: 'not_mentioned',
      detail: { costCny: 0 },
    });
    const originalTrace = [{ step: 'gate', startedAt: targetTime, durationMs: 2, summary: 'not_mentioned' }];
    repository.recordPipelineTrace({ time: targetTime, sessionId: session, messageId: 'replay-target', trace: originalTrace });
    const initialMessageIds = repository.recentMessages(session, 10).map((message) => message.messageId);
    const modelRequests: Array<{ role: string; content: string }[]> = [];
    const pipeline = createMessagePipeline({
      getConfig: () => config,
      repository,
      adapter,
      getNickname: () => adapter.nickname,
      personaRoot,
      callModel: async (_slot, messages, callOptions) => {
        modelRequests.push(messages as Array<{ role: string; content: string }>);
        callOptions.recordUsage({
          time: Date.now(), account: callOptions.account, slot: 'reply', provider: 'fake', model: 'fake-model',
          inputTokens: 10, cachedTokens: 0, outputTokens: 4, costCny: 0.003, latencyMs: 4, ok: true,
        });
        return {
          text: '当前配置生成的新回复。',
          provider: 'fake',
          model: 'fake-model',
          usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 4, costCny: 0.003 },
        };
      },
      now: () => baseTime,
      wait: async () => { throw new Error('replay must not pace or send'); },
    });

    const result = await pipeline(makeIncoming({
      messageId: 'replay-target',
      plainText: '小鱼，请重放这条',
      time: targetTime,
    }), { replay: true });

    assert.equal(result.replay?.wouldReply, true);
    assert.equal(result.replay?.replyText, '当前配置生成的新回复。');
    assert.equal(result.replay?.replyCostCny, 0.003);
    assert.equal(result.replay?.totalCostCny, 0.003);
    assert.deepEqual(result.replay?.trace.map((entry) => entry.step), ['persist', 'gate', 'context', 'generate', 'deliver']);
    assert.match(String(modelRequests[0]?.[1]?.content), /历史上下文/);
    assert.match(String(modelRequests[0]?.[1]?.content), /小鱼，请重放这条/);
    assert.doesNotMatch(String(modelRequests[0]?.[1]?.content), /未来上下文不得进入提示词/);
    assert.doesNotMatch(String(modelRequests[0]?.[1]?.content), /迟到的旧消息不得进入提示词/);
    assert.deepEqual(adapter.calls, []);
    assert.deepEqual(adapter.sent, []);
    assert.deepEqual(repository.recentMessages(session, 10).map((message) => message.messageId), initialMessageIds);
    assert.equal(repository.recentDecisions(10).length, 1);
    assert.deepEqual(repository.pipelineTraceFor(session, 'replay-target')?.trace, originalTrace);
    assert.equal(repository.usageToday().costCny, 0.003);
  });
});

test('replay reports incurred model cost when generation fails', async () => {
  await withRepository(async (repository, personaRoot) => {
    const config = AquariumConfigSchema.parse(makeConfig());
    const adapter = new FakeAdapter();
    const target = makeIncoming({ messageId: 'replay-failure', plainText: '小鱼，请重放这条' });
    repository.saveMessage({
      sessionId: sessionId(target.session),
      messageId: target.messageId,
      senderId: target.senderId,
      senderName: target.senderName,
      isSelf: false,
      plainText: target.plainText,
      segments: target.segments,
      time: target.time,
    });
    const pipeline = createMessagePipeline({
      getConfig: () => config,
      repository,
      adapter,
      getNickname: () => adapter.nickname,
      personaRoot,
      callModel: async (_slot, _messages, callOptions) => {
        callOptions.recordUsage({
          time: Date.now(), account: callOptions.account, slot: 'reply', provider: 'fake', model: 'fake-model',
          inputTokens: 10, cachedTokens: 0, outputTokens: 0, costCny: 0.002, latencyMs: 4, ok: false,
        });
        throw new Error('fake provider failure');
      },
      now: () => baseTime,
    });

    const result = await pipeline(target, { replay: true });

    assert.equal(result.reason, 'llm_error');
    assert.equal(result.replay?.wouldReply, false);
    assert.equal(result.replay?.replyCostCny, 0.002);
    assert.equal(result.replay?.totalCostCny, 0.002);
    assert.equal(repository.usageToday().costCny, 0.002);
  });
});

test('replay respects active rate limits without consuming a live rate slot', async () => {
  await withRepository(async (repository, personaRoot) => {
    let now = baseTime;
    const config = makeConfig({ sessions: {
      [sessionId(groupSession)]: { rate: { perUserPerMinute: 1, perSessionPerMinute: 2, minIntervalSec: 0.1 } },
    } });
    const adapter = new FakeAdapter();
    const modelSlots: string[] = [];
    const pipeline = createMessagePipeline({
      getConfig: () => config,
      repository,
      adapter,
      getNickname: () => adapter.nickname,
      personaRoot,
      callModel: async (slot) => {
        modelSlots.push(slot);
        return {
          text: '当前回复。', provider: 'fake', model: 'fake-model',
          usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
        };
      },
      now: () => now,
      wait: async () => {},
    });
    const first = makeIncoming({ messageId: 'rate-first', senderId: 42, time: now });
    const firstResult = await pipeline(first);
    const adapterCallsAfterFirst = adapter.calls.length;

    const blockedReplay = await pipeline(first, { replay: true });
    assert.equal(firstResult.reason, 'replied');
    assert.equal(blockedReplay.reason, 'rate_limited');
    assert.equal(blockedReplay.replay?.reason, 'rate_limited');
    assert.equal(modelSlots.length, 1);
    assert.equal(adapter.calls.length, adapterCallsAfterFirst);

    now += 200;
    const allowedTarget = makeIncoming({ messageId: 'rate-replay-allowed', senderId: 43, time: now });
    repository.saveMessage({
      sessionId: sessionId(allowedTarget.session),
      messageId: allowedTarget.messageId,
      senderId: allowedTarget.senderId,
      senderName: allowedTarget.senderName,
      isSelf: false,
      plainText: allowedTarget.plainText,
      segments: allowedTarget.segments,
      time: allowedTarget.time,
    });
    const allowedReplay = await pipeline(allowedTarget, { replay: true });
    assert.equal(allowedReplay.reason, 'replay');
    assert.equal(modelSlots.length, 2);
    assert.equal(adapter.calls.length, adapterCallsAfterFirst);

    now += 100;
    const liveAfterReplay = await pipeline(makeIncoming({
      messageId: 'rate-live-after-replay', senderId: 44, time: now,
    }));
    assert.equal(liveAfterReplay.reason, 'replied');
    assert.equal(modelSlots.length, 3);
  });
});

test('replay distinguishes reply-call cost from total multi-slot cost', async () => {
  await withRepository(async (repository, personaRoot) => {
    const config = makeConfig();
    const adapter = new FakeAdapter();
    const target = {
      ...makeIncoming({ messageId: 'replay-image-cost', plainText: '小鱼，看看这张图', time: Date.now() }),
      segments: [
        { type: 'text' as const, text: '小鱼，看看这张图' },
        { type: 'image' as const, url: 'data:image/png;base64,AQID' },
      ],
    };
    repository.saveMessage({
      sessionId: sessionId(target.session),
      messageId: target.messageId,
      senderId: target.senderId,
      senderName: target.senderName,
      isSelf: false,
      plainText: target.plainText,
      segments: target.segments,
      time: target.time,
    });
    const pipeline = createMessagePipeline({
      getConfig: () => config,
      repository,
      adapter,
      getNickname: () => adapter.nickname,
      personaRoot,
      callModel: async (slot, _messages, callOptions) => {
        const costCny = slot === 'vision' ? 0.004 : 0.003;
        callOptions.recordUsage({
          time: Date.now(), account: callOptions.account, slot, provider: 'fake', model: 'fake-model',
          inputTokens: 10, cachedTokens: 0, outputTokens: 2, costCny, latencyMs: 2, ok: true,
        });
        return {
          text: slot === 'vision' ? '一只猫。' : '这是一只猫。',
          provider: 'fake', model: 'fake-model',
          usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 2, costCny },
        };
      },
      now: () => Date.now(),
    });

    const result = await pipeline(target, { replay: true });

    assert.equal(result.replay?.replyCostCny, 0.003);
    assert.equal(result.replay?.totalCostCny, 0.007);
    assert.equal(repository.usageToday().costCny, 0.007);
    assert.deepEqual(adapter.sent, []);
  });
});
