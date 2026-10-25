import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import yaml from 'yaml';
import { AquariumConfigSchema } from '../src/config/schema.ts';
import { createMessagePipeline } from '../src/core/conversation/pipeline.ts';
import { budgetState } from '../src/llm/budget.ts';
import { baseTime, FakeAdapter, makeConfig, makeIncoming, withRepository } from './pipeline-test-helpers.ts';

const config = AquariumConfigSchema.parse(yaml.parse(
  fs.readFileSync(path.resolve('config.example.yaml'), 'utf8'),
));

test('budgetState 在 80% 提醒、100% 超限', () => {
  assert.equal(budgetState(config, 3.99), 'ok');
  assert.equal(budgetState(config, 4), 'warn');
  assert.equal(budgetState(config, 4.99), 'warn');
  assert.equal(budgetState(config, 5), 'exceeded');
});

test('零日预算下被 @ 的消息不调用模型并记录 budget 决策', async () => {
  await withRepository(async (repository, personaRoot) => {
    const zeroBudget = AquariumConfigSchema.parse({
      ...makeConfig(),
      budget: { ...config.budget, dailyCny: 0 },
    });
    const adapter = new FakeAdapter();
    let modelCalls = 0;
    const pipeline = createMessagePipeline({
      getConfig: () => zeroBudget,
      repository,
      adapter,
      getNickname: () => adapter.nickname,
      personaRoot,
      callModel: async () => {
        modelCalls += 1;
        return {
          text: '不应调用', provider: 'fake', model: 'fake-model',
          usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0.01 },
        };
      },
      now: () => baseTime,
      wait: async () => {},
      random: () => 0.5,
    });

    const result = await pipeline(makeIncoming({ mentionsSelf: true }));

    assert.deepEqual(result, { replied: false, reason: 'budget' });
    assert.equal(modelCalls, 0);
    assert.deepEqual(adapter.calls, []);
    assert.equal(repository.recentDecisions(1)[0]?.reason, 'budget');
  });
});

test('generate 把 BudgetExceededError 作为 budget 决策静默处理', async () => {
  await withRepository(async (repository, personaRoot) => {
    const adapter = new FakeAdapter();
    const onErrors: unknown[] = [];
    const pipeline = createMessagePipeline({
      getConfig: () => makeConfig(),
      repository,
      adapter,
      getNickname: () => adapter.nickname,
      personaRoot,
      callModel: async () => {
        throw Object.assign(new Error('budget cap'), { name: 'BudgetExceededError', code: 'BUDGET_EXCEEDED' });
      },
      onError: (error) => { onErrors.push(error); },
      now: () => baseTime,
      wait: async () => {},
      random: () => 0.5,
    });

    const result = await pipeline(makeIncoming({ mentionsSelf: true }));

    assert.deepEqual(result, { replied: false, reason: 'budget' });
    assert.deepEqual(onErrors, []);
    assert.equal(repository.recentDecisions(1)[0]?.reason, 'budget');
  });
});
