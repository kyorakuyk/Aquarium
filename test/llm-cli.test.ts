import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import yaml from 'yaml';
import { AquariumConfigSchema } from '../src/config/schema.ts';
import { buildCliInput, createCliRuntime } from '../src/llm/cli.ts';
import { callSlot } from '../src/llm/slots.ts';

const baseConfig = AquariumConfigSchema.parse(yaml.parse(
  fs.readFileSync(path.resolve('config.example.yaml'), 'utf8'),
));

const echoPid = 'process.stdin.resume();process.stdin.on("end",()=>process.stdout.write(String(process.pid)));';
const echoStdin = 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(s.trim()));';

function cliConfig(script: string, overrides: Record<string, unknown> = {}) {
  return AquariumConfigSchema.parse({
    ...baseConfig,
    providers: {
      ...baseConfig.providers,
      fakecli: {
        kind: 'cli',
        command: process.execPath,
        args: ['-e', script],
        timeoutSec: 5,
        ...overrides,
      },
    },
    slots: { ...baseConfig.slots, reply: [{ provider: 'fakecli', model: 'cli-model' }] },
  });
}

test('buildCliInput prefixes system and conversation messages and separates them with a blank line', () => {
  assert.equal(buildCliInput([
    { role: 'system', content: '规则' },
    { role: 'user', content: '你好' },
  ]), '[系统] 规则\n\n[对话] 你好');
});

test('callSlot runs a CLI provider without shell, records zero-cost usage, and returns trimmed output', async () => {
  const records: Array<Record<string, unknown>> = [];
  const result = await callSlot('reply', [{ role: 'user', content: '  ping  ' }], {
    config: cliConfig(echoStdin),
    account: null,
    costToday: () => 0,
    recordUsage: (usage) => records.push(usage),
  });

  assert.equal(result.text, '[对话]   ping');
  assert.equal(result.provider, 'fakecli');
  assert.equal(result.model, 'cli-model');
  assert.deepEqual(result.params, {});
  assert.equal(records.length, 1);
  assert.equal(records[0]?.ok, true);
  assert.equal(records[0]?.inputTokens, 0);
  assert.equal(records[0]?.cachedTokens, 0);
  assert.equal(records[0]?.outputTokens, 0);
  assert.equal(records[0]?.costCny, 0);
});

test('CLI failures fall back to the next provider and record the failed attempt', async () => {
  const records: Array<Record<string, unknown>> = [];
  const config = AquariumConfigSchema.parse({
    ...baseConfig,
    providers: {
      ...baseConfig.providers,
      fakecli: { kind: 'cli', command: process.execPath, args: ['-e', 'process.exit(4)'], timeoutSec: 5 },
    },
    slots: {
      ...baseConfig.slots,
      reply: [
        { provider: 'fakecli', model: 'cli-model' },
        { provider: 'deepseek', model: 'deepseek-flash' },
      ],
    },
  });
  const result = await callSlot('reply', [{ role: 'user', content: '你好' }], {
    config,
    account: null,
    costToday: () => 0,
    recordUsage: (usage) => records.push(usage),
    getClient: () => ({
      chat: {
        completions: {
          create: async () => ({ choices: [{ message: { content: 'api 回复' } }], usage: null }),
        },
      },
    }) as never,
  });

  assert.equal(result.text, 'api 回复');
  assert.deepEqual(records.map((record) => [record.provider, record.ok]), [
    ['fakecli', false],
    ['deepseek', true],
  ]);
});

test('CLI timeout is a failure and never hangs the caller', async () => {
  const started = Date.now();
  await assert.rejects(
    callSlot('reply', [{ role: 'user', content: '你好' }], {
      config: cliConfig('process.stdin.resume();setInterval(()=>{},1000);', { timeoutSec: 1 }),
      account: null,
      costToday: () => 0,
      recordUsage: () => {},
    }),
    /CLI 调用超时/u,
  );
  assert.ok(Date.now() - started < 5_000);
});

test('prewarm keeps one idle process, replaces it after a call, and stops cleanly', async () => {
  const runtime = createCliRuntime({ restartBaseMs: 20, restartMaxMs: 80 });
  try {
    const config = cliConfig(echoPid, { prewarm: true });
    const provider = config.providers.fakecli;
    assert.ok(provider && provider.kind === 'cli');
    runtime.sync(config.providers);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const before = runtime.status('fakecli');
    assert.equal(before.state, 'ready');
    assert.ok(before.pid);

    const first = await runtime.call('fakecli', provider, 'ping');
    assert.match(first, /^\d+$/u);
    assert.equal(runtime.status('fakecli').served, 1);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const after = runtime.status('fakecli');
    assert.equal(after.state, 'ready');
    assert.notEqual(after.pid, Number(first));

    const second = await runtime.call('fakecli', provider, 'pong');
    assert.match(second, /^\d+$/u);
    assert.notEqual(second, first);
  } finally {
    await runtime.stopAll();
  }
  assert.deepEqual(runtime.status('fakecli'), { state: 'stopped', pid: null, served: 0 });
});

test('a prewarmed CLI that crashes is restarted with backoff', async () => {
  const runtime = createCliRuntime({ restartBaseMs: 20, restartMaxMs: 80 });
  try {
    const config = cliConfig('process.exit(2)', { prewarm: true });
    const provider = config.providers.fakecli;
    assert.ok(provider && provider.kind === 'cli');
    runtime.sync(config.providers);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const status = runtime.status('fakecli');
    assert.ok(status.state === 'restarting' || status.state === 'starting' || status.state === 'ready');
    assert.equal(status.served, 0);
  } finally {
    await runtime.stopAll();
  }
});
