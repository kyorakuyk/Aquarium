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

test('pipeline 从被叫消息到模型回复、引用发送、落库和 replied 决策完整贯通', async () => {
  await withRepository(async (repository, personaRoot) => {
    const adapter = new FakeAdapter();
    const modelRequests: Array<{ slot: string; messages: Array<{ role: string; content: string }> }> = [];
    const waits: number[] = [];
    const config = makeConfig();
    const pipeline = createMessagePipeline({
      getConfig: () => config,
      repository,
      adapter,
      getNickname: () => adapter.nickname,
      personaRoot,
      callModel: async (slot, messages) => {
        modelRequests.push({ slot, messages: messages as Array<{ role: string; content: string }> });
        return {
          text: '**小鱼：** 你好呀！',
          provider: 'deepseek',
          model: 'deepseek-flash',
          usage: { inputTokens: 12, cachedTokens: 0, outputTokens: 4, costCny: 0.0042 },
        };
      },
      now: () => baseTime,
      wait: async (milliseconds) => { waits.push(milliseconds); },
      random: () => 0.4,
    });

    const result = await pipeline(makeIncoming());

    assert.deepEqual(result, { replied: true, reason: 'replied' });
    assert.equal(modelRequests.length, 1);
    assert.equal(modelRequests[0]?.slot, 'reply');
    assert.match(String(modelRequests[0]?.messages[0]?.content), /# Aquarium/);
    assert.match(String(modelRequests[0]?.messages[0]?.content), /这是游戏群。/);
    assert.match(String(modelRequests[0]?.messages[1]?.content), /\[09:05\] "小明": 小鱼，早上好/);
    assert.match(String(modelRequests[0]?.messages[1]?.content), /请回复最后一条提到你的消息。/);
    assert.deepEqual(adapter.calls, ['markRead', 'send']);
    assert.deepEqual(adapter.sent[0]?.segments, [
      { type: 'reply', messageId: 'incoming-1' },
      { type: 'text', text: '你好呀！' },
    ]);
    assert.equal(waits.length, 1);
    assert.deepEqual(
      repository.recentMessages(sessionId(groupSession), 20).map((message) => message.messageId),
      ['incoming-1', 'out-1'],
    );
    const decision = repository.recentDecisions(1)[0];
    assert.equal(decision?.replied, true);
    assert.equal(decision?.reason, 'replied');
    assert.equal((decision?.detail as { costCny?: number }).costCny, 0.0042);
    const detail = decision?.detail as {
      templateVersion?: string;
      visionTemplateVersion?: string;
      promptHash?: string;
      promptFingerprints?: Array<{ slot: string; templateVersion: string; promptHash: string }>;
    };
    assert.equal(
      detail.templateVersion,
      createHash('sha256').update(fs.readFileSync(path.resolve('prompts/reply-system.md'))).digest('hex').slice(0, 8),
    );
    assert.equal(
      detail.visionTemplateVersion,
      createHash('sha256').update(fs.readFileSync(path.resolve('prompts/vision.md'))).digest('hex').slice(0, 8),
    );
    assert.equal(
      detail.promptHash,
      createHash('sha256').update(JSON.stringify(modelRequests[0]?.messages)).digest('hex').slice(0, 16),
    );
    assert.deepEqual(detail.promptFingerprints, [{
      slot: 'reply',
      templateVersion: detail.templateVersion,
      promptHash: detail.promptHash,
    }]);
  });
});

test('pipeline 对未启用会话记录 disabled 且不调用模型', async () => {
  await withRepository(async (repository, personaRoot) => {
    const harness = createHarness(repository, makeConfig({ enabled: false }), personaRoot);

    const result = await harness.pipeline(makeIncoming());

    assert.deepEqual(result, { replied: false, reason: 'disabled' });
    assert.equal(harness.modelRequests.length, 0);
    assert.equal(harness.adapter.sent.length, 0);
    assert.equal(repository.recentMessages(sessionId(groupSession), 5).length, 1);
    const decision = repository.recentDecisions(1)[0];
    assert.equal(decision?.reason, 'disabled');
    assert.equal(typeof (decision?.detail as { templateVersion?: unknown }).templateVersion, 'string');
  });
});

test('pipeline 对重复消息记录 duplicate 且只回复一次', async () => {
  await withRepository(async (repository, personaRoot) => {
    const harness = createHarness(repository, makeConfig(), personaRoot);
    const incoming = makeIncoming({ messageId: 'duplicate-1' });

    const first = await harness.pipeline(incoming);
    const duplicate = await harness.pipeline(incoming);

    assert.deepEqual(first, { replied: true, reason: 'replied' });
    assert.deepEqual(duplicate, { replied: false, reason: 'duplicate' });
    assert.equal(harness.modelRequests.length, 1);
    assert.equal(harness.adapter.sent.length, 1);
    assert.equal(
      repository.recentMessages(sessionId(groupSession), 20)
        .filter((message) => message.messageId === 'duplicate-1').length,
      1,
    );
    assert.equal(repository.recentDecisions(1)[0]?.reason, 'duplicate');
  });
});

test('pipeline 能处理已由离线补课入库的消息而不重复插入', async () => {
  await withRepository(async (repository, personaRoot) => {
    const incoming = makeIncoming({ messageId: 'catch-up-already-saved' });
    assert.equal(repository.saveMessage({
      sessionId: sessionId(incoming.session),
      messageId: incoming.messageId,
      senderId: incoming.senderId,
      senderName: incoming.senderName,
      isSelf: false,
      plainText: incoming.plainText,
      segments: incoming.segments,
      time: incoming.time,
    }), true);
    const harness = createHarness(repository, makeConfig(), personaRoot);

    const result = await harness.pipeline(incoming, { alreadySaved: true });

    assert.deepEqual(result, { replied: true, reason: 'replied' });
    assert.equal(harness.modelRequests.length, 1);
    assert.equal(
      repository.recentMessages(sessionId(incoming.session), 10)
        .filter((message) => message.messageId === incoming.messageId).length,
      1,
    );
  });
});

test('pipeline 对未提及昵称的 mention_only 会话记录 mode_mention_only', async () => {
  await withRepository(async (repository, personaRoot) => {
    const harness = createHarness(repository, makeConfig(), personaRoot);

    const result = await harness.pipeline(makeIncoming({ plainText: '今天晚饭吃什么？' }));

    assert.deepEqual(result, { replied: false, reason: 'mode_mention_only' });
    assert.equal(harness.modelRequests.length, 0);
    assert.equal(repository.recentDecisions(1)[0]?.reason, 'mode_mention_only');
  });
});

test('pipeline 对连续被叫消息执行会话最小间隔限制', async () => {
  await withRepository(async (repository, personaRoot) => {
    const harness = createHarness(repository, makeConfig(), personaRoot);

    const first = await harness.pipeline(makeIncoming({ messageId: 'rate-1' }));
    const second = await harness.pipeline(makeIncoming({
      messageId: 'rate-2',
      plainText: '继续回答',
      mentionsSelf: true,
      time: baseTime - 30_000,
    }));

    assert.equal(first.reason, 'replied');
    assert.deepEqual(second, { replied: false, reason: 'rate_limited' });
    assert.equal(harness.modelRequests.length, 1);
    const detail = repository.recentDecisions(1)[0]?.detail as { limit?: string; templateVersion?: string };
    assert.equal(detail.limit, 'min_interval');
    assert.equal(typeof detail.templateVersion, 'string');
  });
});

test('pipeline 拆分长回复，群聊只在第一条添加引用', async () => {
  await withRepository(async (repository, personaRoot) => {
    const harness = createHarness(repository, makeConfig(), personaRoot, { replyText: '甲'.repeat(161) });

    const result = await harness.pipeline(makeIncoming({ messageId: 'split-1' }));

    assert.equal(result.reason, 'replied');
    assert.deepEqual(harness.adapter.sent.map(({ segments }) => segments), [
      [{ type: 'reply', messageId: 'split-1' }, { type: 'text', text: '甲'.repeat(80) }],
      [{ type: 'text', text: '甲'.repeat(80) }],
      [{ type: 'text', text: '甲' }],
    ]);
    assert.equal(harness.waits.length, 3);
    assert.equal(repository.recentMessages(sessionId(groupSession), 20).length, 4);
  });
});

test('pipeline 每条新消息都读取最新配置', async () => {
  await withRepository(async (repository, personaRoot) => {
    let currentConfig = makeConfig({ enabled: false });
    const harness = createHarness(repository, currentConfig, personaRoot, { getConfig: () => currentConfig });

    const disabled = await harness.pipeline(makeIncoming({ messageId: 'reload-1' }));
    currentConfig = makeConfig({ enabled: true });
    const enabled = await harness.pipeline(makeIncoming({ messageId: 'reload-2', time: baseTime - 30_000 }));

    assert.equal(disabled.reason, 'disabled');
    assert.equal(enabled.reason, 'replied');
  });
});

test('pipeline 私聊无需昵称触发并在发送前标记已读和输入状态', async () => {
  await withRepository(async (repository, personaRoot) => {
    const privateSession: SessionKey = { account: groupSession.account, kind: 'private', peer: 42 };
    const harness = createHarness(repository, makeConfig({ nicknames: [] }), personaRoot);

    const result = await harness.pipeline(makeIncoming({
      session: privateSession,
      messageId: 'private-1',
      plainText: '你好',
    }));

    assert.equal(result.reason, 'replied');
    assert.deepEqual(harness.adapter.calls, ['markRead', 'setTyping', 'send']);
    assert.deepEqual(harness.adapter.sent[0]?.segments, [{ type: 'text', text: '普通回复。' }]);
  });
});

test('pipeline 空回复不发送且模型错误有独立决策原因', async () => {
  await withRepository(async (repository, personaRoot) => {
    const empty = createHarness(repository, makeConfig(), personaRoot, { replyText: ' **   ' });
    const emptyResult = await empty.pipeline(makeIncoming({ messageId: 'empty-1' }));
    assert.deepEqual(emptyResult, { replied: false, reason: 'empty_reply' });
    assert.equal(empty.adapter.calls.length, 0);

    const failing = createHarness(repository, makeConfig(), personaRoot, {
      modelError: Object.assign(new Error('request rejected'), { status: 400 }),
    });
    const failedResult = await failing.pipeline(makeIncoming({ messageId: 'error-1' }));
    assert.deepEqual(failedResult, { replied: false, reason: 'llm_error' });
    assert.equal(failing.adapter.sent.length, 0);
    const detail = repository.recentDecisions(1)[0]?.detail as {
      errorName?: string;
      status?: number;
      templateVersion?: string;
      promptHash?: string;
    };
    assert.equal(detail.errorName, 'Error');
    assert.equal(detail.status, 400);
    assert.equal(typeof detail.templateVersion, 'string');
    assert.equal(typeof detail.promptHash, 'string');
  });
});
