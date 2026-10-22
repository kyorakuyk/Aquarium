import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionId, type SessionKey } from '../src/core/shared/events.ts';
import { syncKinRelays } from '../src/core/privacy/kin-relay.ts';
import { tagActivation } from '../src/core/impressions/tags.ts';
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
    const fakeCredential = 'sk-abc123def456ghi789';
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
      text: `最近准备考研 ${fakeCredential}`,
      keywords: ['考研', '压力大'],
      evidence: [{ messageId: 'private-source', time: now, quote: `聊天内容 ${fakeCredential}` }],
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
    assert.doesNotMatch(body.facts[0]?.text ?? '', /sk-abc123def456ghi789/u);
    assert.deepEqual(body.facts[0]?.keywords, ['考研', '压力大']);
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

test('privacy level changes create only low-confidence relays for explicit kin members', async () => {
  await withPanel(async ({ app, repository }) => {
    const recipientAccount = account + 1;
    const groupId = repository.createKinGroup('隐私转述');
    repository.setKinGroupMembers(groupId, [account, recipientAccount]);
    const id = repository.insertPrivateFact(fact({ level: 'L0' }));

    const response = await app.request(`/api/privacy/facts/${id}?account=${account}`, {
      method: 'PATCH',
      headers: jsonHeaders(),
      body: JSON.stringify({ level: 'L1' }),
    });
    assert.equal(response.status, 200);

    const relays = repository.listRelayTagsForAccount(recipientAccount);
    assert.equal(relays.length, 1);
    assert.equal(relays[0]?.sourceFactId, id);
    assert.equal(relays[0]?.sourceAccount, account);
    assert.ok(tagActivation(relays[0]!, now) < 0.5);
  });
});

test('knowledge view labels a referred tag with its source account', async () => {
  await withPanel(async ({ app, repository }) => {
    const sourceAccount = account + 1;
    const groupId = repository.createKinGroup('知识来源');
    repository.setKinGroupMembers(groupId, [account, sourceAccount]);
    repository.insertPrivateFact(fact({
      account: sourceAccount,
      sessionId: `${sourceAccount}:private:42`,
      level: 'L1',
    }));
    syncKinRelays(repository, now);
    const session: SessionKey = { account, kind: 'group', peer: 77 };

    const response = await app.request(`/api/impressions/${sessionId(session)}`, { headers: authHeaders() });
    assert.equal(response.status, 200);
    const body = await response.json() as {
      kinRelayTags: Array<{ sourceAccount: number | null; source: string }>;
    };
    assert.equal(body.kinRelayTags.length, 1);
    assert.equal(body.kinRelayTags[0]?.sourceAccount, sourceAccount);
    assert.equal(body.kinRelayTags[0]?.source, 'auto');
  });
});

test('knowledge view hides stale relays after the source privacy level is revoked', async () => {
  await withPanel(async ({ app, repository }) => {
    const sourceAccount = account + 1;
    const groupId = repository.createKinGroup('撤销转述');
    repository.setKinGroupMembers(groupId, [account, sourceAccount]);
    const factId = repository.insertPrivateFact(fact({
      account: sourceAccount,
      sessionId: `${sourceAccount}:private:42`,
      level: 'L1',
    }));
    syncKinRelays(repository, now);
    const session: SessionKey = { account, kind: 'group', peer: 78 };
    const path = `/api/impressions/${sessionId(session)}`;
    const allowed = await app.request(path, { headers: authHeaders() });
    assert.equal((await allowed.json() as { kinRelayTags: unknown[] }).kinRelayTags.length, 1);

    repository.updatePrivateFactControls({
      account: sourceAccount,
      ownerId: 42,
      id: factId,
      level: 'L0',
      promoteMentions: 3,
      updatedAt: now + 1,
    });
    const revoked = await app.request(path, { headers: authHeaders() });
    assert.equal((await revoked.json() as { kinRelayTags: unknown[] }).kinRelayTags.length, 0);
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
