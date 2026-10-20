import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrivateFactRecord } from '../src/store/privacy-repo.ts';
import { account, authHeaders, now, withPanel } from './panel-test-helpers.ts';

function fact(patch: Partial<Omit<PrivateFactRecord, 'id'>> = {}): Omit<PrivateFactRecord, 'id'> {
  return {
    account,
    ownerId: 42,
    sessionId: `${account}:private:42`,
    text: '最近在准备考研，压力较大',
    keywords: ['考研', '压力'],
    level: 'L0',
    levelSource: 'auto',
    mentions: 0,
    mentionEvidence: [],
    evidence: [{ messageId: 'private-source', time: now - 1000, quote: '最近有些压力' }],
    status: 'active',
    createdAt: now - 1000,
    updatedAt: now - 1000,
    ...patch,
  };
}

function jsonHeaders(): HeadersInit {
  return { ...authHeaders(), 'Content-Type': 'application/json' };
}

test('privacy GET is authenticated, owner-scoped, and redacts sensitive text and evidence', async () => {
  await withPanel(async ({ app, repository }) => {
    repository.saveMessage({
      sessionId: `${account}:private:42`,
      messageId: 'privacy-name',
      senderId: 42,
      senderName: 'PrivateFriend123',
      isSelf: false,
      plainText: 'hello',
      segments: [],
      time: now,
    });
    const id = repository.insertPrivateFact(fact({
      text: `最近准备考研 abcdefghi`,
      keywords: ['考研', 'abcdefgh'],
      evidence: [{ messageId: 'private-source', time: now, quote: '聊天内容 abcdefghi' }],
    }));
    assert.equal((await app.request(`/api/privacy/42?account=${account}`)).status, 401);

    const response = await app.request(`/api/privacy/42?account=${account}`, { headers: authHeaders() });
    assert.equal(response.status, 200);
    const body = await response.json() as {
      userId: number;
      name: string;
      facts: Array<{ id: number; text: string; textRedacted: boolean; keywords: string[]; level: string; levelSource: string; evidence: Array<{ quote: string }> }>;
    };
    assert.equal(body.userId, 42);
    assert.equal(body.name, 'PrivateFriend123');
    assert.equal(body.facts.length, 1);
    assert.equal(body.facts[0]?.id, id);
    assert.equal(body.facts[0]?.textRedacted, true);
    assert.match(body.facts[0]?.text ?? '', /\[敏感内容已隐藏\]/);
    assert.doesNotMatch(body.facts[0]?.text ?? '', /abcdefgh/);
    assert.deepEqual(body.facts[0]?.keywords, ['考研', '[敏感内容已隐藏]']);
    assert.match(body.facts[0]?.evidence[0]?.quote ?? '', /\[敏感内容已隐藏\]/);
    assert.equal((await app.request('/api/privacy/42?account=999999', { headers: authHeaders() })).status, 400);
  });
});

test('privacy PATCH supports text, manual level, automatic restoration, and rejects invalid scopes', async () => {
  await withPanel(async ({ app, repository }) => {
    const id = repository.insertPrivateFact(fact({ mentions: 1, level: 'L1' }));
    const path = `/api/privacy/facts/${id}?account=${account}`;
    const changed = await app.request(path, {
      method: 'PATCH',
      headers: jsonHeaders(),
      body: JSON.stringify({ text: '新的私聊事实描述', level: 'L2' }),
    });
    assert.equal(changed.status, 200);
    const responseBody = await changed.json() as { fact: { text: string; level: string; levelSource: string } };
    assert.equal(responseBody.fact.text, '新的私聊事实描述');
    assert.equal(responseBody.fact.level, 'L2');
    assert.equal(responseBody.fact.levelSource, 'manual');
    const manual = repository.privateFactById(id);
    assert.equal(manual?.text, '新的私聊事实描述');
    assert.equal(manual?.level, 'L2');
    assert.equal(manual?.levelSource, 'manual');

    const restored = await app.request(path, {
      method: 'PATCH',
      headers: jsonHeaders(),
      body: JSON.stringify({ auto: true }),
    });
    assert.equal(restored.status, 200);
    const automatic = repository.privateFactById(id);
    assert.equal(automatic?.level, 'L1');
    assert.equal(automatic?.levelSource, 'auto');

    const conflict = await app.request(path, {
      method: 'PATCH',
      headers: jsonHeaders(),
      body: JSON.stringify({ level: 'L2', auto: true }),
    });
    assert.equal(conflict.status, 400);

    const wrongOwner = await app.request('/api/privacy/facts/999999?account=999999', {
      method: 'PATCH',
      headers: jsonHeaders(),
      body: JSON.stringify({ level: 'L2' }),
    });
    assert.equal(wrongOwner.status, 400);

    const otherAccountId = repository.insertPrivateFact(fact({
      account: account + 1,
      sessionId: `${account + 1}:private:42`,
    }));
    const crossAccount = await app.request(`/api/privacy/facts/${otherAccountId}?account=${account}`, {
      method: 'PATCH',
      headers: jsonHeaders(),
      body: JSON.stringify({ level: 'L2' }),
    });
    assert.equal(crossAccount.status, 404);
  });
});

test('privacy DELETE soft-deletes the owner-scoped fact', async () => {
  await withPanel(async ({ app, repository }) => {
    const id = repository.insertPrivateFact(fact());
    const response = await app.request(`/api/privacy/facts/${id}?account=${account}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    assert.equal(response.status, 200);
    assert.equal(repository.privateFactById(id)?.status, 'deleted');

    const ownerView = await app.request(`/api/privacy/42?account=${account}`, { headers: authHeaders() });
    assert.equal((await ownerView.json() as { facts: unknown[] }).facts.length, 0);
  });
});
