import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authHeaders, withPanel } from './panel-test-helpers.ts';

const fixtureKey = ['fixture', 'credential'].join('-');
const requestOptions = {
  env: { DEEPSEEK_API_KEY: fixtureKey },
};

async function readModels(response: Response): Promise<{
  models: Array<{ id: string; params: Record<string, string>; sources: Record<string, string> }>;
  modelParams?: Record<string, { temperature?: boolean; maxTokens?: boolean; reasoning?: boolean }>;
  fetchedAt?: number;
  error?: string;
}> {
  return await response.json() as {
    models: Array<{ id: string; params: Record<string, string>; sources: Record<string, string> }>;
    modelParams?: Record<string, { temperature?: boolean; maxTokens?: boolean; reasoning?: boolean }>;
    fetchedAt?: number;
    error?: string;
  };
}

test('provider model endpoint maps advertised and undeclared capabilities', async () => {
  let requests = 0;
  const fetchModels: typeof fetch = async (_input, init) => {
    requests += 1;
    assert.ok(new Headers(init?.headers).get('authorization'));
    return new Response(JSON.stringify({ data: [
      { id: 'plain-model' },
      { id: 'complete-model', supported_parameters: ['temperature', 'max_tokens', 'reasoning_effort'] },
      { id: 'reasoning-model', supported_parameters: ['reasoning'] },
    ] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  await withPanel(async ({ app }) => {
    const response = await app.request('/api/providers/deepseek/models', { headers: authHeaders() });
    assert.equal(response.status, 200);
    const body = await readModels(response);
    assert.deepEqual(body.models.map(({ id, params }) => ({ id, params })), [
      { id: 'plain-model', params: { temperature: 'unknown', maxTokens: 'unknown', reasoning: 'unknown' } },
      { id: 'complete-model', params: { temperature: 'supported', maxTokens: 'supported', reasoning: 'supported' } },
      { id: 'reasoning-model', params: { temperature: 'unsupported', maxTokens: 'unsupported', reasoning: 'supported' } },
    ]);
    assert.equal(body.models[0]?.sources.temperature, 'unknown');
    assert.equal(body.models[1]?.sources.temperature, 'advertised');
    assert.deepEqual(body.modelParams, {});
    assert.equal(typeof body.fetchedAt, 'number');
  }, undefined, { ...requestOptions, fetch: fetchModels });

  assert.equal(requests, 1);
});

test('provider model endpoint applies overrides and caches until forced refresh', async () => {
  let requests = 0;
  const fetchModels: typeof fetch = async (_input, init) => {
    requests += 1;
    assert.ok(new Headers(init?.headers).get('authorization'));
    return new Response(JSON.stringify({ data: [{ id: 'override-model' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  await withPanel(async ({ app }) => {
    const headers = { ...authHeaders(), 'Content-Type': 'application/json' };
    const writeOverride = async (modelParams: Record<string, { temperature?: boolean | null; maxTokens?: boolean | null }>) => app.request('/api/providers/deepseek', {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ modelParams }),
    });
    assert.equal((await writeOverride({ 'override-model': { temperature: true } })).status, 200);

    const first = await readModels(await app.request('/api/providers/deepseek/models', { headers: authHeaders() }));
    assert.deepEqual(first.models[0]?.params, {
      temperature: 'supported', maxTokens: 'unknown', reasoning: 'unknown',
    });

    assert.equal((await writeOverride({ 'override-model': { maxTokens: false } })).status, 200);
    const cached = await readModels(await app.request('/api/providers/deepseek/models', { headers: authHeaders() }));
    assert.deepEqual(cached.modelParams?.['override-model'], { temperature: true, maxTokens: false });
    assert.deepEqual(cached.models[0]?.params, {
      temperature: 'supported', maxTokens: 'unsupported', reasoning: 'unknown',
    });
    assert.equal(cached.models[0]?.sources.temperature, 'override');
    assert.deepEqual(cached.modelParams?.['override-model'], { temperature: true, maxTokens: false });
    const configResponse = await app.request('/api/models', { headers: authHeaders() });
    const configBody = await configResponse.json() as { providers: Array<{ id: string; modelParams?: Record<string, { temperature?: boolean; maxTokens?: boolean }> }> };
    assert.deepEqual(configBody.providers.find((provider) => provider.id === 'deepseek')?.modelParams?.['override-model'], {
      temperature: true, maxTokens: false,
    });
    assert.equal(requests, 1);

    const reset = await writeOverride({ 'override-model': { temperature: null } });
    assert.equal(reset.status, 200);
    const resetConfigResponse = await app.request('/api/models', { headers: authHeaders() });
    const resetConfig = await resetConfigResponse.json() as { providers: Array<{ id: string; modelParams?: Record<string, { temperature?: boolean; maxTokens?: boolean }> }> };
    assert.deepEqual(resetConfig.providers.find((provider) => provider.id === 'deepseek')?.modelParams?.['override-model'], {
      maxTokens: false,
    });
    const afterReset = await readModels(await app.request('/api/providers/deepseek/models', { headers: authHeaders() }));
    assert.deepEqual(afterReset.models[0]?.params, {
      temperature: 'unknown', maxTokens: 'unsupported', reasoning: 'unknown',
    });

    await app.request('/api/providers/deepseek/models?refresh=1', { headers: authHeaders() });
    assert.equal(requests, 2);
  }, undefined, { ...requestOptions, fetch: fetchModels });
});

test('provider model endpoint redacts fetch errors and does not fetch CLI providers', async () => {
  let requests = 0;
  const fetchUnauthorized: typeof fetch = async () => {
    requests += 1;
    return new Response(fixtureKey, { status: 401 });
  };

  await withPanel(async ({ app }) => {
    const response = await app.request('/api/providers/deepseek/models', { headers: authHeaders() });
    assert.equal(response.status, 200);
    const body = await readModels(response);
    assert.deepEqual(body.models, []);
    assert.equal(typeof body.error, 'string');
    assert.equal(JSON.stringify(body).includes(fixtureKey), false);

    const createCli = await app.request('/api/providers', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'fixture-cli', provider: { kind: 'cli', command: 'fixture-command' } }),
    });
    assert.equal(createCli.status, 201);
    const cliResponse = await app.request('/api/providers/fixture-cli/models', { headers: authHeaders() });
    assert.equal(cliResponse.status, 200);
    assert.deepEqual(await cliResponse.json(), { models: [], cli: true });
    assert.equal(requests, 1);
  }, undefined, { ...requestOptions, fetch: fetchUnauthorized });
});
