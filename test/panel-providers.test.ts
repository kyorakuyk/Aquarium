import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createCliRuntime } from '../src/llm/cli.ts';
import { setEnvAssignment } from '../src/panel-server/env-file.ts';
import { authHeaders, now, withPanel } from './panel-test-helpers.ts';

const syntheticKey = ['sk', 'test', 'value', '1234'].join('-');

function envFixture(t: { after: (fn: () => void) => void }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-env-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, '.env');
}

test('.env assignment replaces an existing line in place and preserves comments and other keys', (t) => {
  const envPath = envFixture(t);
  fs.writeFileSync(envPath, [
    '# Aquarium 密钥',
    'OTHER_KEY=keep-me',
    'DEEPSEEK_API_KEY=old-value',
    'TRAILING=last',
    '',
  ].join('\n'), 'utf8');

  const first = fs.readFileSync(envPath, 'utf8');
  const replaced = setEnvAssignment(first, 'DEEPSEEK_API_KEY', syntheticKey);
  assert.match(replaced, /# Aquarium 密钥/u);
  assert.match(replaced, /OTHER_KEY=keep-me/u);
  assert.match(replaced, /TRAILING=last/u);
  assert.equal(replaced.includes('old-value'), false);
  assert.equal(replaced.split('\n').filter((line) => line.startsWith('DEEPSEEK_API_KEY=')).length, 1);
  assert.match(replaced, new RegExp(`DEEPSEEK_API_KEY=${syntheticKey}`, 'u'));

  const appended = setEnvAssignment(replaced, 'NEW_API_KEY', syntheticKey);
  assert.match(appended, new RegExp(`NEW_API_KEY=${syntheticKey}`, 'u'));
  assert.equal(appended.split('\n').filter((line) => line.startsWith('OTHER_KEY=')).length, 1);
});

test('models API and provider lifecycle manage configs without ever returning the key', async () => {
  await withPanel(async ({ app, getConfig, getSavedConfig }) => {
    const headers = { ...authHeaders(), 'Content-Type': 'application/json' };
    const created = await app.request('/api/providers', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        id: 'local-cli',
        provider: { kind: 'cli', command: process.execPath, args: ['-e', 'process.exit(0)'], prewarm: true, timeoutSec: 40 },
      }),
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json() as { id: string; kind: string; runtime: { state: string } };
    assert.equal(createdBody.id, 'local-cli');
    assert.equal(createdBody.kind, 'cli');
    assert.equal(createdBody.runtime.state, 'stopped');
    assert.equal(getConfig().providers['local-cli']?.kind, 'cli');

    const duplicate = await app.request('/api/providers', {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: 'local-cli', provider: { kind: 'cli', command: process.execPath } }),
    });
    assert.equal(duplicate.status, 409);

    const renamed = await app.request('/api/providers/local-cli', {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ label: '本机 CLI', prewarm: false }),
    });
    assert.equal(renamed.status, 200);
    assert.equal(getConfig().providers['local-cli']?.kind, 'cli');
    assert.equal(getConfig().providers['local-cli']?.label, '本机 CLI');
    assert.equal(getConfig().providers['local-cli']?.kind === 'cli' && getConfig().providers['local-cli'].prewarm, false);
    const wrongKindField = await app.request('/api/providers/local-cli', {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ baseUrl: 'https://example.invalid' }),
    });
    assert.equal(wrongKindField.status, 400);

    const invalid = await app.request('/api/providers', {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: 'bad', provider: { kind: 'api', baseUrl: '', apiKeyEnv: 'lowercase' } }),
    });
    assert.equal(invalid.status, 400);

    const models = await app.request('/api/models', { headers: authHeaders() });
    assert.equal(models.status, 200);
    const modelsText = await models.text();
    assert.equal(modelsText.includes(syntheticKey), false);
    const modelsBody = JSON.parse(modelsText) as {
      providers: Array<{ id: string; kind: string; keyStatus: { set: boolean; last4: string } }>;
      slots: Record<string, Array<{ provider: string }>>;
    };
    assert.ok(modelsBody.providers.some((provider) => provider.id === 'local-cli'));
    assert.deepEqual(modelsBody.providers.find((provider) => provider.id === 'deepseek')?.keyStatus.set, false);
    assert.ok(modelsBody.slots.reply?.length);

    const deleteReferenced = await app.request('/api/providers/deepseek', { method: 'DELETE', headers: authHeaders() });
    assert.equal(deleteReferenced.status, 409);
    const conflict = await deleteReferenced.json() as { slots: string[] };
    assert.ok(conflict.slots.includes('reply'));

    const deleteUnused = await app.request('/api/providers/local-cli', { method: 'DELETE', headers: authHeaders() });
    assert.equal(deleteUnused.status, 200);
    assert.equal(getSavedConfig()?.providers['local-cli'], undefined);
  });
});

test('provider key endpoint writes .env, updates the status, and never echoes the value', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-provider-env-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const envPath = path.join(root, '.env');
  fs.writeFileSync(envPath, '# keep this comment\nOTHER=value\n', 'utf8');
  const env: NodeJS.ProcessEnv = {};

  await withPanel(async ({ app }) => {
    const response = await app.request('/api/providers/deepseek/key', {
      method: 'PUT',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: syntheticKey }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.equal(text.includes(syntheticKey), false);
    const body = JSON.parse(text) as { set: boolean; last4: string };
    assert.deepEqual(body, { set: true, last4: '1234' });
    assert.equal(env.DEEPSEEK_API_KEY, syntheticKey);

    const file = fs.readFileSync(envPath, 'utf8');
    assert.match(file, /# keep this comment/u);
    assert.match(file, /OTHER=value/u);
    assert.match(file, new RegExp(`DEEPSEEK_API_KEY=${syntheticKey}`, 'u'));

    const models = await app.request('/api/models', { headers: authHeaders() });
    const modelsText = await models.text();
    assert.equal(modelsText.includes(syntheticKey), false);
    assert.deepEqual(
      (JSON.parse(modelsText) as { providers: Array<{ id: string; keyStatus: unknown }> })
        .providers.find((provider) => provider.id === 'deepseek')?.keyStatus,
      { set: true, last4: '1234' },
    );

    const cliKey = await app.request('/api/providers/deepseek/key', {
      method: 'PUT',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: 'with\nnewline' }),
    });
    assert.equal(cliKey.status, 400);
    assert.equal(fs.readFileSync(envPath, 'utf8').includes('with'), false);
  }, undefined, { envPath, env });
});

test('slot updates validate references and provider tests record usage without exposing parameters', async () => {
  await withPanel(async ({ app, repository }) => {
    const headers = { ...authHeaders(), 'Content-Type': 'application/json' };
    const chain = [{ provider: 'deepseek', model: 'deepseek-flash', temperature: 0.7, maxTokens: 128, reasoning: 'medium' }];
    const updated = await app.request('/api/slots/reply', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ chain }),
    });
    assert.equal(updated.status, 200);
    const updatedBody = await updated.json() as { chain: typeof chain };
    assert.equal(updatedBody.chain[0]?.temperature, 0.7);
    assert.equal(updatedBody.chain[0]?.reasoning, 'medium');

    const unknown = await app.request('/api/slots/reply', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ chain: [{ provider: 'missing', model: 'x' }] }),
    });
    assert.equal(unknown.status, 400);

    const invalidChain = await app.request('/api/slots/reply', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ chain: [] }),
    });
    assert.equal(invalidChain.status, 400);

    const tested = await app.request('/api/providers/deepseek/test', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'deepseek-flash' }),
    });
    assert.equal(tested.status, 200);
    const testBody = await tested.json() as { ok: boolean; latencyMs: number };
    assert.equal(testBody.ok, true);
    assert.equal(typeof testBody.latencyMs, 'number');
    const report = repository.usageByRange('today', now);
    assert.ok(report.rows.some((row) => row.provider === 'deepseek' && row.bySlot.some((slot) => slot.slot === 'test')));
  }, undefined, {
    testProvider: async () => ({ ok: true, latencyMs: 12 }),
    env: {},
  });
});

test('API key values never appear in GET models output even when process env already holds them', async () => {
  await withPanel(async ({ app }) => {
    const response = await app.request('/api/models', { headers: authHeaders() });
    const text = await response.text();
    assert.equal(text.includes(syntheticKey), false);
    assert.equal(text.includes('AQUARIUM_PANEL_PASSWORD'), false);
    const models = JSON.parse(text) as { providers: Array<{ id: string; keyStatus: { set: boolean; last4: string } }> };
    const status = models.providers.find((provider) => provider.id === 'deepseek')?.keyStatus;
    assert.deepEqual(status, { set: true, last4: '1234' });
  }, undefined, {
    env: { DEEPSEEK_API_KEY: syntheticKey },
  });
});

test('provider API exposes the env name but never a key value and rejects unknown fields', async () => {
  await withPanel(async ({ app }) => {
    const models = await app.request('/api/models', { headers: authHeaders() });
    const text = await models.text();
    assert.equal(text.includes('DEEPSEEK_API_KEY'), true);
    assert.equal(text.includes(syntheticKey), false);

    const unknownField = await app.request('/api/providers', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'bad', provider: { kind: 'api', baseUrl: 'https://example.invalid', apiKeyEnv: 'BAD_KEY', extra: true } }),
    });
    assert.equal(unknownField.status, 400);
  });
});

test('CLI providers can be tested and restarted through the API', async () => {
  const runtime = createCliRuntime({ restartBaseMs: 20, restartMaxMs: 80 });
  try {
    await withPanel(async ({ app }) => {
      const headers = { ...authHeaders(), 'Content-Type': 'application/json' };
      const script = 'process.stdin.resume();process.stdin.on("end",()=>process.stdout.write("pong"));';
      const created = await app.request('/api/providers', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          id: 'echo-cli',
          provider: { kind: 'cli', command: process.execPath, args: ['-e', script], prewarm: true, timeoutSec: 5 },
        }),
      });
      assert.equal(created.status, 201);

      const tested = await app.request('/api/providers/echo-cli/test', {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      });
      assert.equal(tested.status, 200);
      assert.equal((await tested.json() as { ok: boolean }).ok, true);

      const restarted = await app.request('/api/providers/echo-cli/restart', { method: 'POST', headers });
      assert.equal(restarted.status, 200);
      const status = await restarted.json() as { state: string };
      assert.ok(status.state === 'starting' || status.state === 'ready');

      const apiOnly = await app.request('/api/providers/deepseek/restart', { method: 'POST', headers });
      assert.equal(apiOnly.status, 400);
    }, undefined, { cliRuntime: runtime });
  } finally {
    await runtime.stopAll();
  }
});
