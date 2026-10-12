import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import test from 'node:test';
import yaml from 'yaml';
import { AquariumConfigSchema } from '../src/config/schema.ts';
import { deepMerge, resolveSession } from '../src/config/resolve.ts';
import { loadConfig } from '../src/config/load.ts';
import { writeConfig } from '../src/config/write.ts';
import path from 'node:path';

const exampleText = fs.readFileSync(new URL('../config.example.yaml', import.meta.url), 'utf8');
const exampleConfig = yaml.parse(exampleText);

test('config.example.yaml 符合配置 schema 并默认关闭所有会话', () => {
  const result = AquariumConfigSchema.safeParse(exampleConfig);

  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.data.owner, 0);
  assert.equal(result.data.defaults.enabled, false);
  assert.equal(result.data.accounts.length, 1);
});

test('配置 schema 拒绝越界端口和负数 owner', () => {
  const invalidPort = structuredClone(exampleConfig) as Record<string, any>;
  invalidPort.panel.port = 70000;
  const negativeOwner = { ...exampleConfig, owner: -1 };

  assert.equal(AquariumConfigSchema.safeParse(invalidPort).success, false);
  assert.equal(AquariumConfigSchema.safeParse(negativeOwner).success, false);
});

test('deepMerge 递归合并对象，但数组整体覆盖', () => {
  assert.deepEqual(deepMerge(
    { labels: ['default-a', 'default-b'], rate: { perUser: 4, perSession: 8 } },
    { labels: ['custom'], rate: { perUser: 1 } },
  ), {
    labels: ['custom'],
    rate: { perUser: 1, perSession: 8 },
  });
});

test('resolveSession 合并全局默认、会话覆盖和局部 rate', () => {
  const config = AquariumConfigSchema.parse({
    ...exampleConfig,
    sessions: {
      '900000001:group:123456': {
        enabled: true,
        nicknames: ['小鱼', '鱼鱼'],
        rate: { perUserPerMinute: 1 },
      },
    },
  });

  const resolved = resolveSession(config, { account: 900000001, kind: 'group', peer: 123456 });

  assert.equal(resolved.enabled, true);
  assert.deepEqual(resolved.nicknames, ['小鱼', '鱼鱼']);
  assert.deepEqual(resolved.rate, {
    perUserPerMinute: 1,
    perSessionPerMinute: 8,
    minIntervalSec: 3,
  });
  assert.equal(resolved.groupNote, '');
});

test('首次加载会复制示例配置并提示用户编辑', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'data', 'config.yaml');
  const notices: unknown[][] = [];

  const loaded = loadConfig({
    configPath,
    examplePath: path.resolve('config.example.yaml'),
    logger: { info: (...values: unknown[]) => notices.push(values), error: () => undefined },
  });

  assert.equal(fs.existsSync(configPath), true);
  assert.equal(loaded.defaults.enabled, false);
  assert.equal(notices.length, 1);
});

test('非法配置会被拒绝而不会被示例内容覆盖', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-config-'));
  try {
    const configPath = path.join(root, 'config.yaml');
    const invalidText = 'owner: -1\n';
    fs.writeFileSync(configPath, invalidText, 'utf8');

    assert.throws(() => loadConfig({
      configPath,
      examplePath: path.resolve('config.example.yaml'),
      logger: { info: () => undefined, error: () => undefined },
    }), /配置校验失败/);
    assert.equal(fs.readFileSync(configPath, 'utf8'), invalidText);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('writeConfig 原子写入 YAML 并清理临时文件', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'config.yaml');
  const config = AquariumConfigSchema.parse(exampleConfig);

  writeConfig(config, configPath);

  assert.deepEqual(yaml.parse(fs.readFileSync(configPath, 'utf8')), config);
  assert.deepEqual(fs.readdirSync(root), ['config.yaml']);
});

test('writeConfig 原子替换旧配置，校验失败时保留旧内容', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'config.yaml');
  const oldText = 'owner: 12\n';
  fs.writeFileSync(configPath, oldText, 'utf8');
  const config = AquariumConfigSchema.parse({ ...exampleConfig, owner: 7 });

  writeConfig(config, configPath);
  assert.deepEqual(yaml.parse(fs.readFileSync(configPath, 'utf8')), config);
  assert.deepEqual(fs.readdirSync(root), ['config.yaml']);

  const invalid = { ...config, panel: { ...config.panel, port: 70000 } };
  assert.throws(() => writeConfig(invalid as never, configPath), /配置校验失败/);
  assert.deepEqual(yaml.parse(fs.readFileSync(configPath, 'utf8')), config);
  assert.deepEqual(fs.readdirSync(root), ['config.yaml']);
});
