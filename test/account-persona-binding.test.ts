import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { account, authHeaders, withPanel } from './panel-test-helpers.ts';

function jsonHeaders(): HeadersInit {
  return { ...authHeaders(), 'Content-Type': 'application/json' };
}

test('账号切换到不存在的人设时拒绝且保持原配置', async () => {
  await withPanel(async ({ app, getConfig }) => {
    const original = getConfig().accounts.find((candidate) => candidate.uin === account);
    assert.ok(original);

    const response = await app.request(`/api/accounts/${account}/persona`, {
      method: 'PUT',
      headers: jsonHeaders(),
      body: JSON.stringify({ persona: 'missing-persona' }),
    });

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'Persona not found' });
    assert.equal(getConfig().accounts.find((candidate) => candidate.uin === account)?.persona, original.persona);
  });
});

test('账号可切换到已存在的人设，重复切换返回相同状态', async () => {
  await withPanel(async ({ app, root, getConfig, getSavedConfig }) => {
    const persona = 'switch-target';
    fs.writeFileSync(path.join(root, 'personas', `${persona}.md`), '# 切换目标\n', 'utf8');

    const request = () => app.request(`/api/accounts/${account}/persona`, {
      method: 'PUT',
      headers: jsonHeaders(),
      body: JSON.stringify({ persona }),
    });
    const firstResponse = await request();
    assert.equal(firstResponse.status, 200);
    const firstState = await firstResponse.json();
    assert.deepEqual(firstState, { account, persona });
    assert.equal(getConfig().accounts.find((candidate) => candidate.uin === account)?.persona, persona);

    const savedConfig = getSavedConfig();
    const secondResponse = await request();
    assert.equal(secondResponse.status, 200);
    assert.deepEqual(await secondResponse.json(), firstState);
    assert.equal(getSavedConfig(), savedConfig);
    assert.equal(getConfig().accounts.find((candidate) => candidate.uin === account)?.persona, persona);
  });
});
