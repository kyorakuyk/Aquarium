import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type OpenAI from 'openai';
import yaml from 'yaml';
import { AquariumConfigSchema } from '../src/config/schema.ts';
import { callSlot, type UsageAttempt } from '../src/llm/slots.ts';

const exampleConfig = AquariumConfigSchema.parse(yaml.parse(
  fs.readFileSync(path.resolve('config.example.yaml'), 'utf8'),
));

test('reply 槽单项降级链遇到连接错误后等待并重试一次，记录两次用量并返回回复', async () => {
  const config = AquariumConfigSchema.parse({
    ...exampleConfig,
    slots: {
      ...exampleConfig.slots,
      reply: [{ provider: 'deepseek', model: 'deepseek-flash' }],
    },
  });
  const models: string[] = [];
  const callTimes: number[] = [];
  const usageRecords: UsageAttempt[] = [];
  const client = {
    chat: {
      completions: {
        create: async ({ model }: { model: string }) => {
          models.push(model);
          callTimes.push(performance.now());
          if (models.length === 1) {
            throw Object.assign(new Error('私密聊天内容不应进入错误摘要'), { code: 'ECONNRESET' });
          }
          return {
            choices: [{ message: { content: '连接恢复后的回复' } }],
            usage: { prompt_tokens: 12, completion_tokens: 4 },
          };
        },
      },
    },
  } as unknown as OpenAI;

  const result = await callSlot('reply', [{ role: 'user', content: '测试消息' }], {
    config,
    account: 42,
    costToday: () => 0,
    getClient: () => client,
    recordUsage: (usage) => usageRecords.push(usage),
  });

  assert.deepEqual(models, ['deepseek-flash', 'deepseek-flash']);
  assert.ok((callTimes[1] ?? 0) - (callTimes[0] ?? 0) >= 990);
  assert.equal(result.text, '连接恢复后的回复');
  assert.equal(result.provider, 'deepseek');
  assert.equal(result.model, 'deepseek-flash');
  assert.deepEqual(usageRecords.map(({ ok }) => ok), [false, true]);
  assert.equal(usageRecords.length, 2);
  assert.equal(usageRecords[0]?.account, 42);
  assert.equal(usageRecords[1]?.account, 42);
  assert.equal(usageRecords[1]?.inputTokens, 12);
  assert.equal(usageRecords[1]?.outputTokens, 4);
});
