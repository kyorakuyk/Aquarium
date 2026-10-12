import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
          usage: { inputTokens: 12, cachedTokens: 0, outputTokens: 4, costCny: 0 },
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
    assert.equal(repository.recentDecisions(1)[0]?.reason, 'disabled');
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

test('pipeline 对未提及昵称的群消息记录 not_mentioned', async () => {
  await withRepository(async (repository, personaRoot) => {
    const harness = createHarness(repository, makeConfig(), personaRoot);

    const result = await harness.pipeline(makeIncoming({ plainText: '今天晚饭吃什么？' }));

    assert.deepEqual(result, { replied: false, reason: 'not_mentioned' });
    assert.equal(harness.modelRequests.length, 0);
    assert.equal(repository.recentDecisions(1)[0]?.reason, 'not_mentioned');
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
    assert.deepEqual(repository.recentDecisions(1)[0]?.detail, { limit: 'min_interval' });
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
    assert.deepEqual(repository.recentDecisions(1)[0]?.detail, { errorName: 'Error', status: 400 });
  });
});
