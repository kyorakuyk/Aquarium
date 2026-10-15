import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type OpenAI from 'openai';
import yaml from 'yaml';
import { AquariumConfigSchema } from '../src/config/schema.ts';
import { isDebugEnabled } from '../src/config/debug.ts';
import { sessionId, type IncomingMessage, type Segment, type SessionKey } from '../src/core/events.ts';
import { createMessagePipeline } from '../src/core/pipeline.ts';
import type { ProtocolAdapter } from '../src/adapters/types.ts';
import { callSlot } from '../src/llm/slots.ts';
import { openDatabase } from '../src/store/db.ts';
import { createRepository, type DebugTraceRecord } from '../src/store/repository.ts';

const exampleConfig = AquariumConfigSchema.parse(yaml.parse(
  fs.readFileSync(path.resolve('config.example.yaml'), 'utf8'),
));
const account = exampleConfig.accounts[0]?.uin ?? 10001;
const groupSession: SessionKey = { account, kind: 'group', peer: 123456 };
const now = new Date(2026, 9, 13, 12, 0).getTime();

function makeConfig(debug: { enabled: boolean; sessions: Record<string, boolean>; retainDays: number }) {
  return AquariumConfigSchema.parse({ ...exampleConfig, debug });
}

function fakeClient(
  create: (request: { model: string; messages: unknown[] }) => Promise<unknown>,
): OpenAI {
  return { chat: { completions: { create } } } as unknown as OpenAI;
}

async function withRepository<T>(
  run: (repository: ReturnType<typeof createRepository>, personaRoot: string) => Promise<T>,
): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-debug-traces-'));
  fs.mkdirSync(path.join(root, 'personas'), { recursive: true });
  fs.writeFileSync(path.join(root, 'personas', 'default.md'), '# {{name}}\n调试测试人设。', 'utf8');
  const database = openDatabase(path.join(root, 'aquarium.db'));
  try {
    return await run(createRepository(database, () => new Date(now)), root);
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

class FakeAdapter implements ProtocolAdapter {
  readonly account = groupSession.account;
  readonly sent: Array<{ session: SessionKey; segments: Segment[] }> = [];
  nickname = 'Aquarium';

  async connect(): Promise<void> {}
  close(): void {}
  onMessage(): () => void { return () => {}; }
  onStatus(): () => void { return () => {}; }
  async send(session: SessionKey, segments: Segment[]): Promise<{ messageId: string }> {
    this.sent.push({ session, segments });
    return { messageId: `out-${this.sent.length}` };
  }
  async listGroups(): Promise<[]> { return []; }
  async listFriends(): Promise<[]> { return []; }
  async history(): Promise<[]> { return []; }
  async markRead(): Promise<void> {}
  async setTyping(): Promise<void> {}
  async recall(): Promise<void> {}
}

function makeIncoming(messageId: string): IncomingMessage {
  return {
    session: groupSession,
    messageId,
    senderId: 42,
    senderName: '小明',
    segments: [{ type: 'text', text: '小鱼，回答一下' }],
    plainText: '小鱼，回答一下',
    mentionsSelf: false,
    replyToSelf: false,
    time: now - 30_000,
  };
}

function traceRecord(overrides: Partial<DebugTraceRecord> = {}): DebugTraceRecord {
  return {
    time: now,
    sessionId: sessionId(groupSession),
    messageId: 'debug-message',
    slot: 'reply',
    provider: 'deepseek',
    model: 'deepseek-flash',
    promptJson: '[{"role":"user","content":"hello"}]',
    responseText: '你好',
    promptHash: '0123456789abcdef',
    detail: {},
    ...overrides,
  };
}

test('debug.sessions 按会话覆盖全局开关', () => {
  const disabled = makeConfig({ enabled: false, sessions: {}, retainDays: 7 });
  const enabledOverride = makeConfig({
    enabled: false,
    sessions: { [sessionId(groupSession)]: true },
    retainDays: 7,
  });
  const disabledOverride = makeConfig({
    enabled: true,
    sessions: { [sessionId(groupSession)]: false },
    retainDays: 7,
  });

  assert.equal(isDebugEnabled(disabled, sessionId(groupSession)), false);
  assert.equal(isDebugEnabled(enabledOverride, sessionId(groupSession)), true);
  assert.equal(isDebugEnabled(disabledOverride, sessionId(groupSession)), false);
  assert.equal(isDebugEnabled(disabledOverride, 'another:private:1'), true);
});

test('callSlot 记录完整 prompt、原始响应和稳定 prompt hash', async () => {
  await withRepository(async (repository) => {
    const config = makeConfig({ enabled: true, sessions: {}, retainDays: 7 });
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'user', content: '完整提示词' },
    ];
    const promptJson = JSON.stringify(messages);
    const expectedHash = createHash('sha256').update(promptJson).digest('hex').slice(0, 16);
    let promptHash = '';
    const client = fakeClient(async () => ({
      choices: [{ message: { content: '原始模型响应' } }],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    }));

    await callSlot('reply', messages, {
      config,
      costToday: () => 0,
      getClient: () => client,
      now: () => now,
      recordUsage: () => {},
      debugTrace: {
        sessionId: sessionId(groupSession),
        messageId: 'debug-message',
        record: (record) => repository.recordDebugTrace(record),
        onPromptHash: (hash) => { promptHash = hash; },
      },
    });

    const traces = repository.debugTracesFor(sessionId(groupSession), 'debug-message');
    assert.equal(traces.length, 1);
    assert.equal(traces[0]?.promptJson, promptJson);
    assert.equal(traces[0]?.responseText, '原始模型响应');
    assert.equal(traces[0]?.promptHash, expectedHash);
    assert.equal(promptHash, expectedHash);
    assert.deepEqual(traces[0]?.detail, {});
  });
});

test('debug 未开启时 callSlot 不写入提示词或响应全文', async () => {
  await withRepository(async (repository) => {
    const config = makeConfig({ enabled: false, sessions: {}, retainDays: 7 });
    const client = fakeClient(async () => ({
      choices: [{ message: { content: '不应入库的响应' } }],
      usage: null,
    }));

    await callSlot('reply', [{ role: 'user', content: '不应入库的提示词' }], {
      config,
      costToday: () => 0,
      getClient: () => client,
      now: () => now,
      recordUsage: () => {},
    });

    assert.deepEqual(repository.debugTracesFor(sessionId(groupSession), 'debug-message'), []);
  });
});

test('callSlot 为失败降级尝试和成功尝试分别记录 trace', async () => {
  await withRepository(async (repository) => {
    const config = makeConfig({ enabled: true, sessions: {}, retainDays: 7 });
    let attempts = 0;
    const client = fakeClient(async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('服务暂不可用'), { status: 503 });
      return { choices: [{ message: { content: '降级回复' } }], usage: null };
    });

    await callSlot('reply', [{ role: 'user', content: '测试失败 trace' }], {
      config,
      costToday: () => 0,
      getClient: () => client,
      now: () => now,
      recordUsage: () => {},
      debugTrace: {
        sessionId: sessionId(groupSession),
        messageId: 'fallback-message',
        record: (record) => repository.recordDebugTrace(record),
        onPromptHash: () => {},
      },
    });

    const traces = repository.debugTracesFor(sessionId(groupSession), 'fallback-message');
    assert.equal(traces.length, 2);
    assert.equal(traces[0]?.responseText, '');
    assert.deepEqual(traces[0]?.detail, { errorName: 'Error', status: 503 });
    assert.equal(traces[1]?.responseText, '降级回复');
    assert.deepEqual(traces[1]?.detail, {});
  });
});

test('pipeline 将启用调试时的 promptHash 写入决策 detail', async () => {
  await withRepository(async (repository, personaRoot) => {
    const config = AquariumConfigSchema.parse({
      ...exampleConfig,
      defaults: { ...exampleConfig.defaults, enabled: true, nicknames: ['小鱼'] },
      debug: { enabled: true, sessions: {}, retainDays: 7 },
    });
    const adapter = new FakeAdapter();
    const pipeline = createMessagePipeline({
      getConfig: () => config,
      repository,
      adapter,
      getNickname: () => adapter.nickname,
      personaRoot,
      now: () => now,
      wait: async () => {},
      random: () => 0.4,
      callModel: async (_slot, _messages, options) => {
        options.debugTrace?.onPromptHash('abcdef0123456789');
        return {
          text: '测试回复',
          provider: 'deepseek',
          model: 'deepseek-flash',
          usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 2, costCny: 0 },
        };
      },
    });

    await pipeline(makeIncoming('prompt-hash-message'));

    const decision = repository.recentDecisions(1)[0];
    assert.equal((decision?.detail as { promptHash?: string } | undefined)?.promptHash, 'abcdef0123456789');
  });
});

test('pipeline 模板初始化失败时仍为调试会话保存空 trace', async () => {
  await withRepository(async (repository) => {
    const key = sessionId(groupSession);
    const config = makeConfig({ enabled: false, sessions: { [key]: true }, retainDays: 7 });
    const message = makeIncoming('pipeline-template-load-error');
    const pipeline = createMessagePipeline({
      getConfig: () => config,
      getPromptTemplates: () => { throw new Error('template loader failed'); },
      repository,
      adapter: new FakeAdapter(),
      getNickname: () => 'Aquarium',
    });

    await assert.rejects(pipeline(message), /template loader failed/);

    assert.equal(repository.hasPipelineTrace(key, message.messageId), true);
    assert.deepEqual(repository.pipelineTraceFor(key, message.messageId)?.trace, []);
  });
});

test('pipeline 将 N1 步骤 trace 保存到 pipeline_traces 且提示词全文只在 debug_traces', async () => {
  await withRepository(async (repository, personaRoot) => {
    const key = sessionId(groupSession);
    const marker = 'TRACE_CANARY_ONLY_IN_DEBUG_TRACE';
    const message = makeIncoming('pipeline-trace-message');
    message.plainText = `小鱼，${marker}`;
    message.segments = [{ type: 'text', text: message.plainText }];
    const config = AquariumConfigSchema.parse({
      ...exampleConfig,
      defaults: { ...exampleConfig.defaults, enabled: true, nicknames: ['小鱼'] },
      debug: { enabled: false, sessions: { [key]: true }, retainDays: 7 },
    });
    const adapter = new FakeAdapter();
    const pipeline = createMessagePipeline({
      getConfig: () => config,
      repository,
      adapter,
      getNickname: () => adapter.nickname,
      personaRoot,
      now: () => now,
      wait: async () => {},
      random: () => 0.4,
      callModel: async (slot, messages, options) => {
        const promptJson = JSON.stringify(messages);
        const promptHash = createHash('sha256').update(promptJson).digest('hex').slice(0, 16);
        const debugTrace = options.debugTrace;
        debugTrace?.onPromptHash(promptHash);
        debugTrace?.record({
          time: now,
          sessionId: debugTrace.sessionId,
          messageId: debugTrace.messageId,
          slot,
          provider: 'deepseek',
          model: 'deepseek-flash',
          promptJson,
          responseText: '测试回复',
          promptHash,
          detail: {},
        });
        return {
          text: '测试回复',
          provider: 'deepseek',
          model: 'deepseek-flash',
          usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 2, costCny: 0 },
        };
      },
    });

    await pipeline(message);

    const trace = repository.pipelineTraceFor(key, message.messageId);
    assert.ok(trace);
    assert.deepEqual(trace.trace.map((entry) => (entry as { step: string }).step), [
      'persist', 'gate', 'context', 'generate', 'deliver',
    ]);
    assert.equal(JSON.stringify(trace.trace).includes(marker), false);
    assert.ok(trace.trace.every((entry) => Array.from((entry as { summary: string }).summary).length <= 500));
    assert.equal(repository.hasPipelineTrace(key, message.messageId), true);
    assert.ok(repository.debugTracesFor(key, message.messageId).some((entry) => entry.promptJson.includes(marker)));
    assert.equal(repository.recentDecisions(1)[0]?.reason, 'replied');
  });
});

test('pipeline 调试关闭时仍记录决策但不写 pipeline trace', async () => {
  await withRepository(async (repository, personaRoot) => {
    const key = sessionId(groupSession);
    const config = AquariumConfigSchema.parse({
      ...exampleConfig,
      defaults: { ...exampleConfig.defaults, enabled: true, nicknames: ['小鱼'] },
      debug: { enabled: false, sessions: {}, retainDays: 7 },
    });
    const adapter = new FakeAdapter();
    const pipeline = createMessagePipeline({
      getConfig: () => config,
      repository,
      adapter,
      getNickname: () => adapter.nickname,
      personaRoot,
      now: () => now,
      wait: async () => {},
      random: () => 0.4,
      callModel: async () => ({
        text: '测试回复',
        provider: 'deepseek',
        model: 'deepseek-flash',
        usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 2, costCny: 0 },
      }),
    });

    const result = await pipeline(makeIncoming('pipeline-debug-disabled'));

    assert.deepEqual(result, { replied: true, reason: 'replied' });
    assert.equal(repository.pipelineTraceFor(key, 'pipeline-debug-disabled'), undefined);
    assert.equal(repository.hasPipelineTrace(key, 'pipeline-debug-disabled'), false);
    assert.equal(repository.recentDecisions(1)[0]?.reason, 'replied');
  });
});

test('pipeline trace 按会话与消息读写且按保留期清理', async () => {
  await withRepository(async (repository) => {
    const day = 24 * 60 * 60 * 1000;
    const cutoff = now - 7 * day;
    const trace = [{ step: 'persist', startedAt: now, durationMs: 1, summary: 'next' }];
    repository.recordPipelineTrace({
      time: cutoff - 1,
      sessionId: sessionId(groupSession),
      messageId: 'pipeline-expired',
      trace,
    });
    repository.recordPipelineTrace({
      time: cutoff,
      sessionId: sessionId(groupSession),
      messageId: 'pipeline-boundary',
      trace,
    });
    repository.recordPipelineTrace({
      time: now,
      sessionId: 'another:group:9',
      messageId: 'pipeline-other-session',
      trace,
    });

    assert.equal(repository.hasPipelineTrace(sessionId(groupSession), 'pipeline-boundary'), true);
    assert.deepEqual(repository.pipelineTraceFor(sessionId(groupSession), 'pipeline-boundary')?.trace, trace);
    assert.equal(repository.prunePipelineTraces(now, 7), 1);
    assert.equal(repository.pipelineTraceFor(sessionId(groupSession), 'pipeline-expired'), undefined);
    assert.ok(repository.pipelineTraceFor(sessionId(groupSession), 'pipeline-boundary'));
    assert.ok(repository.pipelineTraceFor('another:group:9', 'pipeline-other-session'));

    const replacement = [{ step: 'gate', startedAt: now + 1, durationMs: 2, summary: 'disabled' }];
    repository.recordPipelineTrace({
      time: now + 1,
      sessionId: sessionId(groupSession),
      messageId: 'pipeline-boundary',
      trace: replacement,
    });
    assert.deepEqual(repository.pipelineTraceFor(sessionId(groupSession), 'pipeline-boundary')?.trace, replacement);
  });
});

test('debug trace 查询按会话与消息筛选，保留期清理早于阈值的记录', async () => {
  await withRepository(async (repository) => {
    const day = 24 * 60 * 60 * 1000;
    const cutoff = now - 7 * day;
    repository.recordDebugTrace(traceRecord({ messageId: 'expired', time: cutoff - 1 }));
    repository.recordDebugTrace(traceRecord({ messageId: 'boundary', time: cutoff }));
    repository.recordDebugTrace(traceRecord({
      sessionId: 'another:group:9',
      messageId: 'other-session',
      time: now,
    }));

    assert.equal(repository.pruneDebugTraces(now, 7), 1);
    assert.deepEqual(
      repository.debugTracesFor(sessionId(groupSession), 'expired'),
      [],
    );
    assert.equal(repository.debugTracesFor(sessionId(groupSession), 'boundary').length, 1);
    assert.equal(repository.debugTracesFor('another:group:9', 'other-session').length, 1);
  });
});
