import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import yaml from 'yaml';
import { AquariumConfigSchema } from '../src/config/schema.ts';
import { budgetState } from '../src/llm/budget.ts';

const config = AquariumConfigSchema.parse(yaml.parse(
  fs.readFileSync(path.resolve('config.example.yaml'), 'utf8'),
));

test('budgetState 在 80% 提醒、100% 超限', () => {
  assert.equal(budgetState(config, 3.99), 'ok');
  assert.equal(budgetState(config, 4), 'warn');
  assert.equal(budgetState(config, 4.99), 'warn');
  assert.equal(budgetState(config, 5), 'exceeded');
});

test('budget 为零时阻止任何回复调用', () => {
  const zeroBudget = { ...config, budget: { ...config.budget, dailyCny: 0 } };

  assert.equal(budgetState(zeroBudget, 0), 'exceeded');
});
