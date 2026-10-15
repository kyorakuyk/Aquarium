import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import yaml from 'yaml';
import { AquariumConfigSchema } from '../src/config/schema.ts';
import { sessionId, type IncomingMessage, type Segment, type SessionKey } from '../src/core/events.ts';
import { createMessagePipeline } from '../src/core/pipeline.ts';
import type { ProtocolAdapter } from '../src/adapters/types.ts';
import { openDatabase } from '../src/store/db.ts';
import { createRepository } from '../src/store/repository.ts';

const exampleConfig = AquariumConfigSchema.parse(yaml.parse(
  fs.readFileSync(path.resolve('config.example.yaml'), 'utf8'),
));
const groupSession: SessionKey = { account: 900000001, kind: 'group', peer: 123456 };
const baseTime = new Date(2026, 9, 12, 9, 6).getTime();

function makeConfig(options: {
  enabled?: boolean;
  nicknames?: string[];
  groupNote?: string;
  sessions?: Record<string, unknown>;
} = {}) {
  return AquariumConfigSchema.parse({
    ...exampleConfig,
    defaults: {
      ...exampleConfig.defaults,
      enabled: options.enabled ?? true,
      nicknames: options.nicknames ?? ['小鱼'],
      groupNote: options.groupNote ?? '这是游戏群。',
    },
    sessions: { ...exampleConfig.sessions, ...options.sessions },
  });
}

function makeIncoming(options: {
  messageId?: string;
  session?: SessionKey;
  plainText?: string;
  mentionsSelf?: boolean;
  senderId?: number;
  time?: number;
} = {}): IncomingMessage {
  const plainText = options.plainText ?? '小鱼，早上好';
  return {
    session: options.session ?? groupSession,
    messageId: options.messageId ?? 'incoming-1',
    senderId: options.senderId ?? 42,
    senderName: '小明',
    segments: [{ type: 'text', text: plainText }],
    plainText,
    mentionsSelf: options.mentionsSelf ?? false,
    replyToSelf: false,
    time: options.time ?? baseTime - 60_000,
  };
}

class FakeAdapter implements ProtocolAdapter {
  readonly account = groupSession.account;
  readonly sent: Array<{ session: SessionKey; segments: Segment[] }> = [];
  readonly calls: string[] = [];
  nickname = 'Aquarium';

  async connect(): Promise<void> {}
  close(): void {}
  onMessage(): () => void { return () => {}; }
  onStatus(): () => void { return () => {}; }
  async send(session: SessionKey, segments: Segment[]): Promise<{ messageId: string }> {
    this.calls.push('send');
    this.sent.push({ session, segments });
    return { messageId: `out-${this.sent.length}` };
  }
  async listGroups(): Promise<[]> { return []; }
  async listFriends(): Promise<[]> { return []; }
  async history(): Promise<[]> { return []; }
  async markRead(): Promise<void> { this.calls.push('markRead'); }
  async setTyping(): Promise<void> { this.calls.push('setTyping'); }
  async recall(): Promise<void> {}
}

async function withRepository<T>(
  run: (repository: ReturnType<typeof createRepository>, personaRoot: string) => Promise<T>,
): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-pipeline-'));
  fs.mkdirSync(path.join(root, 'personas'), { recursive: true });
  fs.writeFileSync(path.join(root, 'personas', 'default.md'), '# {{name}}\n临时测试人设。', 'utf8');
  const database = openDatabase(path.join(root, 'aquarium.db'));
  try {
    return await run(createRepository(database), root);
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function createHarness(
  repository: ReturnType<typeof createRepository>,
  config: ReturnType<typeof makeConfig>,
  personaRoot: string,
  options: {
    replyText?: string;
    modelError?: Error;
    getConfig?: () => ReturnType<typeof makeConfig>;
  } = {},
) {
  const adapter = new FakeAdapter();
  const modelRequests: Array<{ slot: string; messages: Array<{ role: string; content: string }> }> = [];
  const waits: number[] = [];
  const pipeline = createMessagePipeline({
    getConfig: options.getConfig ?? (() => config),
    repository,
    adapter,
    getNickname: () => adapter.nickname,
    personaRoot,
    callModel: async (slot, messages) => {
      modelRequests.push({ slot, messages: messages as Array<{ role: string; content: string }> });
      if (options.modelError) throw options.modelError;
      return {
        text: options.replyText ?? '普通回复。',
        provider: 'deepseek',
        model: 'deepseek-flash',
        usage: { inputTokens: 12, cachedTokens: 0, outputTokens: 4, costCny: 0 },
      };
    },
    now: () => baseTime,
    wait: async (milliseconds) => { waits.push(milliseconds); },
    random: () => 0.4,
  });
  return { adapter, modelRequests, waits, pipeline };
}

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
          time: Date.now(), slot: 'reply', provider: 'fake', model: 'fake-model',
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
          time: Date.now(), slot: 'reply', provider: 'fake', model: 'fake-model',
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
          time: Date.now(), slot, provider: 'fake', model: 'fake-model',
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
