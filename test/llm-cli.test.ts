import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
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

test('日预算耗尽时仍允许零成本 CLI 槽位', async () => {
  const records: Array<Record<string, unknown>> = [];
  const config = AquariumConfigSchema.parse({
    ...cliConfig(echoStdin),
    budget: { ...baseConfig.budget, dailyCny: 0 },
  });
  const result = await callSlot('reply', [{ role: 'user', content: 'ping' }], {
    config,
    account: null,
    costToday: () => 0,
    recordUsage: (usage) => records.push(usage),
  });

  assert.equal(result.text, '[对话] ping');
  assert.equal(records[0]?.slot, 'reply');
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

test('slot timeout overrides the CLI provider timeout', async () => {
  const started = Date.now();
  const config = AquariumConfigSchema.parse({
    ...cliConfig('process.stdin.resume();setInterval(()=>{},1000);', { timeoutSec: 30, prewarm: true }),
    slots: {
      ...baseConfig.slots,
      reply: [{ provider: 'fakecli', model: 'cli-model', timeoutSec: 1 }],
    },
  });
  const runtime = createCliRuntime();
  try {
    await assert.rejects(
      callSlot('reply', [{ role: 'user', content: '你好' }], {
        config,
        account: null,
        costToday: () => 0,
        recordUsage: () => {},
        cliRuntime: runtime,
      }),
      /CLI 调用超时/u,
    );
    assert.ok(Date.now() - started < 5_000);
  } finally {
    await runtime.stopAll();
  }
});

test('CLI timeout escalates to a hard kill when graceful termination is ignored', async () => {
  const killSignals: Array<NodeJS.Signals | number | undefined> = [];
  const trackedSpawn = ((...args: Parameters<typeof spawn>) => {
    const child = spawn(...args);
    const kill = child.kill.bind(child);
    child.kill = (signal?: NodeJS.Signals | number) => {
      killSignals.push(signal);
      return signal === 'SIGKILL' ? kill(signal) : true;
    };
    return child;
  }) as typeof spawn;
  const runtime = createCliRuntime({ spawnProcess: trackedSpawn });
  try {
    const config = cliConfig('process.stdin.resume();setInterval(()=>{},1000);', { timeoutSec: 1 });
    const provider = config.providers.fakecli;
    assert.ok(provider && provider.kind === 'cli');
    await assert.rejects(runtime.call('fakecli', provider, 'ping'), /CLI 调用超时/u);
    assert.ok(killSignals.includes('SIGKILL'));
  } finally {
    await runtime.stopAll();
  }
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

test('concurrent prewarm calls leave exactly one idle process', async () => {
  const children: Array<ReturnType<typeof spawn>> = [];
  const trackedSpawn = ((...args: Parameters<typeof spawn>) => {
    const child = spawn(...args);
    children.push(child);
    return child;
  }) as typeof spawn;
  const runtime = createCliRuntime({ spawnProcess: trackedSpawn });
  const config = cliConfig(echoStdin, { prewarm: true });
  const provider = config.providers.fakecli;
  assert.ok(provider && provider.kind === 'cli');
  try {
    runtime.sync(config.providers);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const results = await Promise.all([
      runtime.call('fakecli', provider, 'first'),
      runtime.call('fakecli', provider, 'second'),
    ]);
    assert.deepEqual(results, ['first', 'second']);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(children.length, 3);
    assert.equal(children.filter((child) => child.exitCode === null && child.signalCode === null).length, 1);
    assert.deepEqual(runtime.status('fakecli'), {
      state: 'ready',
      pid: children[2]?.pid ?? null,
      served: 2,
    });
  } finally {
    await runtime.stopAll();
  }
});

test('a prewarmed CLI that crashes is restarted with backoff', async () => {
  const spawnTimes: number[] = [];
  let nextPid = 100;
  const trackedSpawn = (() => {
    spawnTimes.push(Date.now());
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const process = child as unknown as ChildProcessWithoutNullStreams;
    Object.assign(child, {
      pid: nextPid++,
      exitCode: null,
      signalCode: null,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => {
        Object.assign(child, { signalCode: 'SIGTERM' });
        child.emit('exit', null, 'SIGTERM');
        child.emit('close', null, 'SIGTERM');
        return true;
      },
    });
    queueMicrotask(() => {
      Object.assign(child, { exitCode: 2 });
      child.emit('spawn');
      child.emit('exit', 2, null);
    });
    return process;
  }) as unknown as typeof spawn;
  const runtime = createCliRuntime({ spawnProcess: trackedSpawn, restartBaseMs: 30, restartMaxMs: 120 });
  try {
    const config = cliConfig('process.exit(2)', { prewarm: true });
    runtime.sync(config.providers);
    await new Promise((resolve) => setTimeout(resolve, 260));
    const status = runtime.status('fakecli');
    assert.ok(status.state === 'restarting' || status.state === 'starting' || status.state === 'ready');
    assert.equal(status.served, 0);
    assert.ok(spawnTimes.length >= 3);
    const intervals = spawnTimes.slice(1).map((time, index) => time - (spawnTimes[index] ?? time));
    assert.ok(intervals[1]! > intervals[0]! + 15, `expected exponential restart delay, got ${intervals.join(', ')}`);
  } finally {
    await runtime.stopAll();
  }
});

test('stopAll terminates in-flight one-shot and consumed prewarm processes', async () => {
  for (const prewarm of [false, true]) {
    const children: Array<ReturnType<typeof spawn>> = [];
    const trackedSpawn = ((...args: Parameters<typeof spawn>) => {
      const child = spawn(...args);
      children.push(child);
      return child;
    }) as typeof spawn;
    const runtime = createCliRuntime({ spawnProcess: trackedSpawn });
    const providerConfig = cliConfig('process.stdin.resume();setInterval(()=>{},1000);', { prewarm, timeoutSec: 10 });
    const provider = providerConfig.providers.fakecli;
    assert.ok(provider && provider.kind === 'cli');
    let call: Promise<string> | undefined;
    try {
      call = runtime.call('fakecli', provider, 'ping');
      void call.catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 80));
      const child = children[0];
      assert.ok(child);
      await runtime.stopAll();
      const closed = child.exitCode !== null || child.signalCode !== null || await Promise.race([
        once(child, 'close').then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
      ]);
      assert.equal(closed, true, `prewarm=${prewarm} child remained alive after stopAll`);
      await assert.rejects(call);
    } finally {
      for (const child of children) {
        if (child.exitCode === null) child.kill();
      }
      await call?.catch(() => undefined);
      await runtime.stopAll();
    }
  }
});
