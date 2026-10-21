import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionId } from '../src/core/shared/events.ts';
import { createMemberSummaryRepository } from '../src/store/member-summary-repo.ts';
import { account, authHeaders, groupSession, now, withPanel } from './panel-test-helpers.ts';

function jsonHeaders(): HeadersInit {
  return { ...authHeaders(), 'Content-Type': 'application/json' };
}

test('群友一句话印象可手动保存、读回且限制为 50 个 Unicode 字符', async () => {
  await withPanel(async ({ app, database, repository }) => {
    const key = sessionId(groupSession);
    repository.insertTag({
      account,
      sessionId: key,
      userId: 42,
      text: '幽默',
      norm: '幽默',
      category: 'personality',
      subject: null,
      polarity: null,
      origin: 'inferred',
      locked: false,
      status: 'confirmed',
      source: 'auto',
      samples: 2,
      evidence: [],
      firstSeen: now,
      lastSeen: now,
      supersededBy: null,
      updatedAt: now,
    });
    const endpoint = `/api/member-summaries/${encodeURIComponent(key)}/42`;
    const save = await app.request(endpoint, {
      method: 'PUT',
      headers: jsonHeaders(),
      body: JSON.stringify({ text: '安静细致，喜欢深入交流。' }),
    });

    assert.equal(save.status, 200);
    assert.deepEqual(await save.json(), {
      account,
      userId: 42,
      text: '安静细致，喜欢深入交流。',
      manual: true,
      updatedAt: now,
    });
    assert.deepEqual(createMemberSummaryRepository(database).get(account, 42), {
      account,
      userId: 42,
      text: '安静细致，喜欢深入交流。',
      manual: true,
      updatedAt: now,
    });

    const read = await app.request(endpoint, { headers: authHeaders() });
    assert.equal(read.status, 200);
    assert.equal((await read.json() as { text: string }).text, '安静细致，喜欢深入交流。');
    assert.equal((await app.request(`/api/member-summaries/${encodeURIComponent(key)}/43`, {
      method: 'PUT',
      headers: jsonHeaders(),
      body: JSON.stringify({ text: '没有这个成员' }),
    })).status, 404);
    assert.equal((await app.request(endpoint, {
      method: 'PUT',
      headers: jsonHeaders(),
      body: JSON.stringify({ text: '语'.repeat(51) }),
    })).status, 400);
  });
});

test('没有当前群标签的合法成员可读取 null，但仍不能写入摘要', async () => {
  await withPanel(async ({ app }) => {
    const endpoint = `/api/member-summaries/${encodeURIComponent(sessionId(groupSession))}/43`;
    const read = await app.request(endpoint, { headers: authHeaders() });
    assert.equal(read.status, 200);
    assert.equal(await read.json(), null);

    const write = await app.request(endpoint, {
      method: 'PUT',
      headers: jsonHeaders(),
      body: JSON.stringify({ text: '没有当前群标签' }),
    });
    assert.equal(write.status, 404);
  });
});
