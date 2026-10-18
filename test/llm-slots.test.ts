import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import yaml from 'yaml';
import { AquariumConfigSchema } from '../src/config/schema.ts';
import { callSlot } from '../src/llm/slots.ts';

const config = AquariumConfigSchema.parse(yaml.parse(
  fs.readFileSync(path.resolve('config.example.yaml'), 'utf8'),
));

function clientFor(
  create: (
    request: { model: string } & Record<string, unknown>,
    options?: { timeout?: number; maxRetries?: number },
  ) => Promise<unknown>,
) {
  return { chat: { completions: { create } } };
}

test('callSlot 在 5xx 时降级并分别记录失败与成功用量', async () => {
  const models: string[] = [];
  const usageRecords: Array<Record<string, unknown>> = [];
  const client = clientFor(async ({ model }) => {
    models.push(model);
    if (models.length === 1) throw Object.assign(new Error('服务暂不可用'), { status: 503 });
    return {
      choices: [{ message: { content: '你好。' } }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 40 },
      },
    };
  });

  const result = await callSlot('reply', [{ role: 'user', content: '你好' }], {
    config,
    account: 42,
    costToday: () => 0,
    getClient: () => client,
    now: () => 1_000,
    recordUsage: (record) => usageRecords.push(record),
  });

  assert.deepEqual(models, ['deepseek-v4-pro', 'deepseek-flash']);
  assert.equal(result.text, '你好。');
  assert.equal(usageRecords.length, 2);
  assert.equal(usageRecords[0]?.account, 42);
  assert.equal(usageRecords[1]?.account, 42);
  assert.equal(usageRecords[0]?.ok, false);
  assert.equal(usageRecords[1]?.ok, true);
  assert.equal(usageRecords[1]?.inputTokens, 100);
  assert.equal(usageRecords[1]?.cachedTokens, 40);
  assert.equal(usageRecords[1]?.outputTokens, 20);
  assert.equal(usageRecords[1]?.costCny, (60 * 1.1 + 40 * 0.02 + 20 * 4.3) / 1_000_000);
});

test('callSlot injects configured API parameters and reports only sent params', async () => {
  const provider = config.providers.deepseek;
  assert.ok(provider);
  const configured = AquariumConfigSchema.parse({
    ...config,
    providers: { ...config.providers, deepseek: { ...provider, reasoningField: 'effort' } },
    slots: { ...config.slots, reply: [{
      provider: 'deepseek', model: 'deepseek-flash', temperature: 0.4, maxTokens: 77, reasoning: 'high',
    }] },
  });
  const requestBodies: Array<Record<string, unknown>> = [];
  const result = await callSlot('reply', [{ role: 'user', content: 'ping' }], {
    config: configured,
    account: null,
    costToday: () => 0,
    getClient: () => clientFor(async (request) => {
      requestBodies.push(request);
      return { choices: [{ message: { content: 'pong' } }], usage: null };
    }),
    recordUsage: () => {},
  });

  assert.equal(requestBodies[0]?.temperature, 0.4);
  assert.equal(requestBodies[0]?.max_tokens, 77);
  assert.equal(requestBodies[0]?.effort, 'high');
  assert.deepEqual(result.params, { temperature: 0.4, maxTokens: 77, reasoning: 'high' });
});

test('reasoningField none omits reasoning from the API request and trace params', async () => {
  const provider = config.providers.deepseek;
  assert.ok(provider);
  const configured = AquariumConfigSchema.parse({
    ...config,
    providers: { ...config.providers, deepseek: { ...provider, reasoningField: 'none' } },
    slots: { ...config.slots, reply: [{ provider: 'deepseek', model: 'deepseek-flash', reasoning: 'high' }] },
  });
  let requestBody: Record<string, unknown> | undefined;
  const result = await callSlot('reply', [{ role: 'user', content: 'ping' }], {
    config: configured,
    account: null,
    costToday: () => 0,
    getClient: () => clientFor(async (request) => {
      requestBody = request;
      return { choices: [{ message: { content: 'pong' } }], usage: null };
    }),
    recordUsage: () => {},
  });

  assert.ok(requestBody);
  assert.equal(Object.hasOwn(requestBody, 'reasoning'), false);
  assert.equal(Object.hasOwn(requestBody, 'reasoning_effort'), false);
  assert.deepEqual(result.params, {});
});

test('callSlot 默认使用 30 秒超时且超时后切换模型', async () => {
  const models: string[] = [];
  const requestOptions: Array<{ timeout?: number; maxRetries?: number } | undefined> = [];
  const usageRecords: Array<Record<string, unknown>> = [];
  const client = clientFor(async ({ model }, options) => {
    models.push(model);
    requestOptions.push(options);
    if (models.length === 1) {
      throw Object.assign(new Error('请求超时'), { name: 'APIConnectionTimeoutError' });
    }
    return { choices: [{ message: { content: '已切换' } }], usage: null };
  });

  const result = await callSlot('reply', [{ role: 'user', content: '你好' }], {
    config,
    account: null,
    costToday: () => 0,
    getClient: () => client,
    now: () => 2_000,
    recordUsage: (record) => usageRecords.push(record),
  });

  assert.deepEqual(models, ['deepseek-v4-pro', 'deepseek-flash']);
  assert.ok(requestOptions.every((options) => options?.timeout === 30_000));
  assert.ok(requestOptions.every((options) => options?.maxRetries === 0));
  assert.equal(result.text, '已切换');
  assert.deepEqual(usageRecords.map((record) => record.ok), [false, true]);
});

test('callSlot 对 408、429 和网络错误继续尝试降级项', async () => {
  const transientErrors = [
    Object.assign(new Error('请求超时'), { status: 408 }),
    Object.assign(new Error('请求过多'), { status: 429 }),
    new TypeError('fetch failed'),
  ];

  for (const transientError of transientErrors) {
    const models: string[] = [];
    const client = clientFor(async ({ model }) => {
      models.push(model);
      if (models.length === 1) throw transientError;
      return { choices: [{ message: { content: '降级成功' } }], usage: null };
    });

    await callSlot('reply', [{ role: 'user', content: '你好' }], {
      config,
      account: null,
      costToday: () => 0,
      getClient: () => client,
      now: () => 2_500,
      recordUsage: () => {},
    });

    assert.deepEqual(models, ['deepseek-v4-pro', 'deepseek-flash']);
  }
});

test('callSlot 遇到 400、401、403 或 404 时不降级', async () => {
  for (const status of [400, 401, 403, 404]) {
    let attempts = 0;
    const usageRecords: Array<Record<string, unknown>> = [];
    const client = clientFor(async () => {
      attempts += 1;
      throw Object.assign(new Error(`HTTP ${status}`), { status });
    });

    await assert.rejects(
      callSlot('reply', [{ role: 'user', content: '你好' }], {
        config,
        account: null,
        costToday: () => 0,
        getClient: () => client,
        now: () => 2_750,
        recordUsage: (record) => usageRecords.push(record),
      }),
      (error) => (error as Error & { status?: number }).status === status,
    );
    assert.equal(attempts, 1);
    assert.equal(usageRecords.length, 1);
    assert.equal(usageRecords[0]?.ok, false);
    assert.equal(usageRecords[0]?.inputTokens, 0);
    assert.equal(usageRecords[0]?.costCny, 0);
  }
});

test('callSlot 支持 DeepSeek 的顶层缓存命中 token 字段', async () => {
  const usageRecords: Array<Record<string, unknown>> = [];
  const client = clientFor(async () => ({
    choices: [{ message: { content: '缓存已统计' } }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 10,
      prompt_cache_hit_tokens: 30,
      prompt_tokens_details: { cached_tokens: 20 },
    },
  }));

  await callSlot('reply', [{ role: 'user', content: '你好' }], {
    config,
    account: null,
    costToday: () => 0,
    getClient: () => client,
    now: () => 2_600,
    recordUsage: (record) => usageRecords.push(record),
  });

  assert.equal(usageRecords[0]?.cachedTokens, 30);
});

test('预算超限时 reply 槽位只调用降级链最后一项', async () => {
  const models: string[] = [];
  const usageRecords: Array<Record<string, unknown>> = [];
  const client = clientFor(async ({ model }) => {
    models.push(model);
    return { choices: [{ message: { content: '预算内回复' } }], usage: null };
  });

  await callSlot('reply', [{ role: 'user', content: '你好' }], {
    config,
    account: null,
    costToday: () => config.budget.dailyCny,
    getClient: () => client,
    now: () => 3_000,
    recordUsage: (record) => usageRecords.push(record),
  });

  assert.deepEqual(models, ['deepseek-flash']);
  assert.equal(usageRecords.length, 1);
  assert.equal(usageRecords[0]?.inputTokens, 0);
  assert.equal(usageRecords[0]?.costCny, 0);
});
