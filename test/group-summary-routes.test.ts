import assert from 'node:assert/strict';
import test from 'node:test';
import { account, authHeaders, groupSession, now, withPanel } from './panel-test-helpers.ts';

function jsonHeaders(): HeadersInit {
  return { ...authHeaders(), 'Content-Type': 'application/json' };
}

test('group summary can be manually saved, read back, and validates single-line length', async () => {
  await withPanel(async ({ app, repository }) => {
    const sessionId = `${account}:group:${groupSession.peer}`;
    const endpoint = `/api/group-summaries/${encodeURIComponent(sessionId)}`;
    const initial = await app.request(endpoint, { headers: authHeaders() });
    assert.equal(initial.status, 200);
    assert.equal(await initial.json(), null);

    const saved = await app.request(endpoint, {
      method: 'PUT',
      headers: jsonHeaders(),
      body: JSON.stringify({ text: '夜里常聚在一起讨论游戏。' }),
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), {
      account,
      sessionId,
      text: '夜里常聚在一起讨论游戏。',
      manual: true,
      updatedAt: now,
    });
    assert.equal(repository.getGroupSummary(account, sessionId)?.manual, true);
    assert.equal((await app.request(endpoint, { headers: authHeaders() })).status, 200);

    assert.equal((await app.request(endpoint, {
      method: 'PUT',
      headers: jsonHeaders(),
      body: JSON.stringify({ text: '话'.repeat(51) }),
    })).status, 400);
    assert.equal((await app.request(endpoint, {
      method: 'PUT',
      headers: jsonHeaders(),
      body: JSON.stringify({ text: '一行\n两行' }),
    })).status, 400);
  });
});
