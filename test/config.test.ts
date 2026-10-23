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
  assert.equal(result.data.debug.enabled, false);
  assert.equal(result.data.debug.retainDays, 7);
  assert.equal(result.data.accounts.length, 1);
  assert.deepEqual(
    (result.data as unknown as { profile?: { schedule?: unknown } }).profile?.schedule,
    {
      minimumMessages: 50,
      nightOwlRatio: 0.4,
      weekendActiveRatio: 1.5,
      morningRatio: 0.03,
      morningMinimumMessages: 100,
    },
  );
});

test('mood 新默认与旧 halfLifeMin 兼容', () => {
  const withoutMood = structuredClone(exampleConfig) as Record<string, any>;
  delete withoutMood.mood;
  const defaults = AquariumConfigSchema.parse(withoutMood).mood;
  const legacy = AquariumConfigSchema.parse({
    ...withoutMood,
    mood: { enabled: true, baseline: { valence: 0.1, arousal: 0.4 }, halfLifeMin: 30 },
  }).mood;
  const separate = AquariumConfigSchema.parse({
    ...withoutMood,
    mood: { enabled: true, surfaceHalfLifeMin: 55, arousalHalfLifeMin: 25, reserve: { initial: 0.6 } },
  }).mood;

  assert.equal(defaults.surfaceHalfLifeMin, 40);
  assert.equal(defaults.arousalHalfLifeMin, 40);
  assert.deepEqual(defaults.reserve, { initial: 0.8 });
  assert.equal(legacy.surfaceHalfLifeMin, 30);
  assert.equal(legacy.arousalHalfLifeMin, 30);
  assert.equal(separate.surfaceHalfLifeMin, 55);
  assert.equal(separate.arousalHalfLifeMin, 25);
  assert.deepEqual(separate.reserve, { initial: 0.6 });
});

test('send.dedupeWindowMs 默认 8000，且 0 表示关闭', () => {
  const legacyConfig = structuredClone(exampleConfig) as Record<string, unknown>;
  delete legacyConfig.send;
  const defaults = AquariumConfigSchema.parse(legacyConfig);
  const disabled = AquariumConfigSchema.parse({ ...legacyConfig, send: { dedupeWindowMs: 0 } });

  assert.equal(defaults.send.dedupeWindowMs, 8_000);
  assert.equal(disabled.send.dedupeWindowMs, 0);
});

test('stickers 默认关闭并校验比例、冷却与候选数', () => {
  const legacyConfig = structuredClone(exampleConfig) as Record<string, unknown>;
  delete legacyConfig.stickers;
  const defaults = AquariumConfigSchema.parse(legacyConfig);

  assert.deepEqual(defaults.stickers, {
    enabled: false,
    maxRatio: 0.3,
    onlyStickerRatio: 0.1,
    cooldownSec: 300,
    candidates: 8,
  });
  assert.throws(() => AquariumConfigSchema.parse({
    ...legacyConfig,
    stickers: { enabled: true, maxRatio: 1.1 },
  }));
});

test('privacy 兼容旧配置、填充字段默认值并校验类型', () => {
  const legacyConfig = structuredClone(exampleConfig) as Record<string, unknown>;
  delete legacyConfig.privacy;
  const legacy = AquariumConfigSchema.parse(legacyConfig);
  const partial = AquariumConfigSchema.parse({
    ...legacyConfig,
    privacy: { enabled: false, promoteMentions: 4 },
  });

  assert.deepEqual(legacy.privacy, { enabled: true, promoteMentions: 3, avoidMinutes: 10 });
  assert.deepEqual(partial.privacy, { enabled: false, promoteMentions: 4, avoidMinutes: 10 });
  assert.equal(AquariumConfigSchema.safeParse({
    ...legacyConfig,
    privacy: { enabled: true, promoteMentions: '3', avoidMinutes: 10 },
  }).success, false);
});

test('V4 defaults keep legacy provider and slot configuration compatible', () => {
  const legacyConfig = structuredClone(exampleConfig) as Record<string, any>;
  for (const provider of Object.values(legacyConfig.providers) as Array<Record<string, unknown>>) {
    delete provider.kind;
    delete provider.label;
    delete provider.reasoningField;
  }
  for (const chain of Object.values(legacyConfig.slots) as Array<Array<Record<string, unknown>>>) {
    for (const entry of chain) {
      delete entry.temperature;
      delete entry.maxTokens;
      delete entry.reasoning;
    }
  }

  const parsed = AquariumConfigSchema.parse(legacyConfig);
  assert.equal(parsed.providers.deepseek?.kind, 'api');
  assert.equal(parsed.providers.deepseek?.reasoningField, 'reasoning_effort');
  assert.equal(parsed.slots.reply?.[0]?.reasoning, 'off');
  assert.equal(parsed.slots.reply?.[0]?.temperature, undefined);
  assert.equal(parsed.slots.reply?.[0]?.maxTokens, undefined);
});

test('reasoningField rejects request identity and parameter names', () => {
  const invalid = structuredClone(exampleConfig) as Record<string, any>;
  invalid.providers.deepseek.reasoningField = 'model';
  assert.equal(AquariumConfigSchema.safeParse(invalid).success, false);
});

test('旧配置缺少 debug 时补入安全默认值', () => {
  const legacyConfig = structuredClone(exampleConfig) as Record<string, unknown>;
  delete legacyConfig.debug;
  const parsed = AquariumConfigSchema.parse(legacyConfig);
  const partial = AquariumConfigSchema.parse({ ...legacyConfig, debug: { enabled: true } });

  assert.deepEqual(parsed.debug, { enabled: false, sessions: {}, retainDays: 7 });
  assert.deepEqual(partial.debug, { enabled: true, sessions: {}, retainDays: 7 });
});

test('host 示例与旧配置都得到明确的托管默认值', () => {
  const expected = {
    enabled: true,
    startSnowLuma: true,
    qqExePath: '',
    scanIntervalSec: 5,
  };
  const legacyConfig = structuredClone(exampleConfig) as Record<string, unknown>;
  delete legacyConfig.host;

  assert.deepEqual(AquariumConfigSchema.parse(exampleConfig).host, expected);
  assert.deepEqual(AquariumConfigSchema.parse(legacyConfig).host, expected);
  assert.deepEqual(AquariumConfigSchema.parse({
    ...legacyConfig,
    host: { enabled: false },
  }).host, { ...expected, enabled: false });
});

test('host 扫描间隔必须为正整数', () => {
  const invalidConfig = {
    ...exampleConfig,
    host: { enabled: true, startSnowLuma: true, qqExePath: '', scanIntervalSec: 0 },
  };
  const result = AquariumConfigSchema.safeParse(invalidConfig);

  assert.equal(result.success, false);
  if (result.success) return;
  assert.ok(result.error.issues.some((issue) => issue.path.join('.') === 'host.scanIntervalSec'));
});

test('配置 schema 拒绝越界端口和负数 owner', () => {
  const invalidPort = structuredClone(exampleConfig) as Record<string, any>;
  invalidPort.panel.port = 70000;
  const negativeOwner = { ...exampleConfig, owner: -1 };

  assert.equal(AquariumConfigSchema.safeParse(invalidPort).success, false);
  assert.equal(AquariumConfigSchema.safeParse(negativeOwner).success, false);
});

test('旧配置的 modeSchedule 默认为空，会话数组整体覆盖默认时间表', () => {
  const legacyConfig = structuredClone(exampleConfig) as Record<string, any>;
  delete legacyConfig.defaults.modeSchedule;
  assert.deepEqual(AquariumConfigSchema.parse(legacyConfig).defaults.modeSchedule, []);

  const defaultSchedule = [{ from: '09:00', to: '12:00', mode: 'active' }];
  const sessionSchedule = [{ from: '23:00', to: '07:00', mode: 'busy' }];
  const config = AquariumConfigSchema.parse({
    ...exampleConfig,
    defaults: { ...exampleConfig.defaults, modeSchedule: defaultSchedule },
    sessions: { '7:group:9': { modeSchedule: sessionSchedule } },
  });

  assert.deepEqual(config.defaults.modeSchedule, defaultSchedule);
  assert.deepEqual(resolveSession(config, { account: 7, kind: 'group', peer: 9 }).modeSchedule, sessionSchedule);
});

test('旧配置的主动冷却默认为 120 秒并限制在可配置范围内', () => {
  const legacyConfig = structuredClone(exampleConfig) as Record<string, any>;
  delete legacyConfig.defaults.proactiveCooldownSec;
  const parsed = AquariumConfigSchema.parse(legacyConfig);
  assert.equal(parsed.defaults.proactiveCooldownSec, 120);

  assert.equal(AquariumConfigSchema.safeParse({
    ...exampleConfig,
    defaults: { ...exampleConfig.defaults, proactiveCooldownSec: 0 },
  }).success, true);
  assert.equal(AquariumConfigSchema.safeParse({
    ...exampleConfig,
    defaults: { ...exampleConfig.defaults, proactiveCooldownSec: 3601 },
  }).success, false);
});

test('talkOffset 默认继承为 0，会话覆盖限制在 -2 到 2', () => {
  const legacyConfig = structuredClone(exampleConfig) as Record<string, any>;
  delete legacyConfig.defaults.talkOffset;
  const parsed = AquariumConfigSchema.parse(legacyConfig);
  assert.equal(parsed.defaults.talkOffset, 0);

  const config = AquariumConfigSchema.parse({
    ...exampleConfig,
    sessions: { '7:group:9': { talkOffset: -2 } },
  });
  assert.equal(resolveSession(config, { account: 7, kind: 'group', peer: 9 }).talkOffset, -2);
  assert.equal(AquariumConfigSchema.safeParse({
    ...exampleConfig,
    sessions: { '7:group:9': { talkOffset: 3 } },
  }).success, false);
});

test('作息旧配置得到关闭默认值并校验时间格式', () => {
  const legacyConfig = structuredClone(exampleConfig) as Record<string, any>;
  delete legacyConfig.sleep;
  assert.deepEqual(AquariumConfigSchema.parse(legacyConfig).sleep, {
    enabled: false,
    bedtime: '02:00',
    wake: '09:00',
    wakeWords: ['起床', '醒醒', '别睡了'],
    goodnight: true,
  });

  assert.equal(AquariumConfigSchema.safeParse({
    ...exampleConfig,
    sleep: { ...exampleConfig.sleep, bedtime: '25:00' },
  }).success, false);
  assert.equal(AquariumConfigSchema.safeParse({
    ...exampleConfig,
    sleep: { ...exampleConfig.sleep, wake: '7:00' },
  }).success, false);
});

test('modeSchedule 拒绝非 HH:mm 时间和未知模式', () => {
  const invalidTime = structuredClone(exampleConfig) as Record<string, any>;
  invalidTime.defaults.modeSchedule = [{ from: '24:00', to: '07:00', mode: 'busy' }];
  const invalidMode = structuredClone(exampleConfig) as Record<string, any>;
  invalidMode.defaults.modeSchedule = [{ from: '09:00', to: '12:00', mode: 'quiet' }];
  const equalEndpoints = structuredClone(exampleConfig) as Record<string, any>;
  equalEndpoints.defaults.modeSchedule = [{ from: '09:00', to: '09:00', mode: 'busy' }];

  assert.equal(AquariumConfigSchema.safeParse(invalidTime).success, false);
  assert.equal(AquariumConfigSchema.safeParse(invalidMode).success, false);
  assert.equal(AquariumConfigSchema.safeParse(equalEndpoints).success, false);
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

test('无法解析的 YAML 配置被拒绝且原文件保持不变', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'config.yaml');
  const invalidText = 'owner: [\n';
  fs.writeFileSync(configPath, invalidText, 'utf8');

  assert.throws(() => loadConfig({
    configPath,
    examplePath: path.resolve('config.example.yaml'),
    logger: { info: () => undefined, error: () => undefined },
  }), /配置 YAML 无法解析/);
  assert.equal(fs.readFileSync(configPath, 'utf8'), invalidText);
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
