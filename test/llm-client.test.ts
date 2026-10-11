import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import yaml from 'yaml';
import { AquariumConfigSchema } from '../src/config/schema.ts';
import { createOpenAIClient, createProviderClientRegistry } from '../src/llm/client.ts';

const exampleConfig = AquariumConfigSchema.parse(yaml.parse(
  fs.readFileSync(path.resolve('config.example.yaml'), 'utf8'),
));

test('provider client registry 按 provider 缓存并隔离不同 provider', () => {
  const created: string[] = [];
  const registry = createProviderClientRegistry((name, provider) => {
    created.push(name);
    return { name, baseUrl: provider.baseUrl };
  });

  const first = registry.get(exampleConfig, 'deepseek');
  const second = registry.get(exampleConfig, 'deepseek');
  const mimo = registry.get(exampleConfig, 'mimo');

  assert.equal(first, second);
  assert.notEqual(first, mimo);
  assert.deepEqual(created, ['deepseek', 'mimo']);
});

test('provider 地址或环境变量名变化时重建缓存的客户端', () => {
  const registry = createProviderClientRegistry((name, provider) => ({
    name,
    baseUrl: provider.baseUrl,
  }));
  const first = registry.get(exampleConfig, 'deepseek');
  const changedConfig = {
    ...exampleConfig,
    providers: {
      ...exampleConfig.providers,
      deepseek: { ...exampleConfig.providers.deepseek, baseUrl: 'https://new.example.invalid/v1' },
    },
  };

  const second = registry.get(changedConfig, 'deepseek');

  assert.notEqual(first, second);
  assert.equal(second.baseUrl, 'https://new.example.invalid/v1');
});

test('OpenAI client 缺少配置的环境变量时明确失败', () => {
  const provider = { baseUrl: 'https://example.invalid/v1', apiKeyEnv: 'AQUARIUM_MISSING_KEY' };

  assert.throws(() => createOpenAIClient(provider, {}), /AQUARIUM_MISSING_KEY/);
});
