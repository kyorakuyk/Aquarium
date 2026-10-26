import assert from 'node:assert/strict';
import test from 'node:test';
import { account, authHeaders, now, withPanel } from './panel-test-helpers.ts';

function jsonHeaders(): HeadersInit {
  return { ...authHeaders(), 'Content-Type': 'application/json' };
}

test('persona memory read is authenticated, account-scoped, and redacts stored text', async () => {
  await withPanel(async ({ app, repository }) => {
    assert.equal((await app.request('/api/persona-memory/accounts')).status, 401);
    const accountsResponse = await app.request('/api/persona-memory/accounts', { headers: authHeaders() });
    assert.equal(accountsResponse.status, 200);
    assert.deepEqual(await accountsResponse.json(), [{ account, name: 'Aquarium 测试' }]);
    const bearerValue = ['FAKE', '_SECRET', '_TOKEN', '_123456'].join('');
    const canary = `Authorization: Bearer ${bearerValue}`;
    assert.equal(repository.insertPersonaEventMemo({
      account,
      sessionId: `${account}:private:42`,
      eventId: null,
      title: '周末计划',
      summary: `今天提到的安排 ${canary}`,
      participantIds: [42],
      startMessageId: 'panel-memo',
      endMessageId: 'panel-memo',
      level: 'L0',
      createdAt: now,
    }), true);
    const memoId = repository.listPersonaEventMemos(account, 10)[0]?.id;
    assert.ok(memoId);
    const pendingSessionId = `${account}:private:42`;
    repository.saveMessage({
      sessionId: pendingSessionId,
      messageId: 'panel-organized-message',
      senderId: 42,
      senderName: '朋友',
      isSelf: false,
      plainText: '已整理的原文缓存',
      segments: [],
      time: now - 2_000,
    });
    repository.saveMessage({
      sessionId: pendingSessionId,
      messageId: 'panel-pending-message',
      senderId: 42,
      senderName: '朋友',
      isSelf: false,
      plainText: '暂存区计数 fixture',
      segments: [],
      time: now,
    });
    repository.savePersonaMemoryCursor({
      account,
      sessionId: pendingSessionId,
      organizedUntilMessageTime: now - 1_000,
      openSegmentStart: now,
    });
    repository.insertPersonaDiary({
      account,
      cycleKey: '2026-10-22',
      text: `日记内容 ${canary}`,
      sourceMemoIds: [memoId],
      sourceCount: 1,
      createdAt: now,
    });
    repository.insertPersonaEventMemo({
      account: account + 1,
      sessionId: `${account + 1}:private:42`,
      eventId: null,
      title: '别的账号',
      summary: '别的账号内容',
      participantIds: [42],
      startMessageId: 'other-account-memo',
      endMessageId: 'other-account-memo',
      level: 'L0',
      createdAt: now,
    });

    assert.equal((await app.request(`/api/persona-memory?account=${account}`)).status, 401);
    const response = await app.request(`/api/persona-memory?account=${account}`, { headers: authHeaders() });
    assert.equal(response.status, 200);
    const body = await response.json() as {
      account: number;
      pendingMessageCount: number;
      openSegmentCount: number;
      cacheSessions: Array<{ sessionId: string; label: string; pendingMessageCount: number }>;
      memos: Array<{ title: string; summary: string; level: string; eventId: number | null }>;
      diaries: Array<{ text: string; sourceMemoIds: number[]; visibleToAni: boolean }>;
    };
    assert.equal(body.account, account);
    assert.equal(body.pendingMessageCount, 1);
    assert.equal(body.openSegmentCount, 1);
    assert.deepEqual(body.cacheSessions, [{
      sessionId: pendingSessionId,
      label: '私聊 42',
      pendingMessageCount: 1,
    }]);
    assert.equal(body.memos.length, 1);
    assert.equal(body.memos[0]?.title, '周末计划');
    assert.ok(body.memos[0]?.summary.includes('[敏感内容已隐藏]'));
    assert.doesNotMatch(JSON.stringify(body), new RegExp(bearerValue));
    assert.doesNotMatch(JSON.stringify(body), /abcdefghijklmnop/u);
    assert.doesNotMatch(JSON.stringify(body), /别的账号内容/u);
    assert.equal(body.diaries.length, 1);
    assert.deepEqual(body.diaries[0]?.sourceMemoIds, [memoId]);
    assert.equal(body.diaries[0]?.visibleToAni, true);
    assert.ok(body.diaries[0]?.text.includes('[敏感内容已隐藏]'));
    assert.equal((await app.request('/api/persona-memory?account=999999', { headers: authHeaders() })).status, 400);

    const cachePath = `/api/persona-memory/cache?account=${account}&sessionId=${encodeURIComponent(pendingSessionId)}`;
    assert.equal((await app.request(cachePath, { method: 'DELETE' })).status, 401);
    const cleared = await app.request(cachePath, { method: 'DELETE', headers: authHeaders() });
    assert.equal(cleared.status, 200);
    assert.deepEqual(await cleared.json(), { account, sessionId: pendingSessionId, deletedMessages: 1 });
    assert.equal(repository.messageBySessionAndId(pendingSessionId, 'panel-organized-message'), undefined);
    assert.ok(repository.messageBySessionAndId(pendingSessionId, 'panel-pending-message'));
    assert.equal(repository.listPersonaEventMemos(account, 10).length, 1);
    assert.equal(repository.listPersonaDiaries(account, 10).length, 1);
    const foreignSessionId = `${account + 1}:private:42`;
    assert.equal((await app.request(
      `/api/persona-memory/cache?account=${account}&sessionId=${encodeURIComponent(foreignSessionId)}`,
      { method: 'DELETE', headers: authHeaders() },
    )).status, 400);
  });
});

test('persona diary visibility update reads back the exact account-owned record', async () => {
  await withPanel(async ({ app, repository }) => {
    const id = repository.insertPersonaDiary({
      account,
      cycleKey: '2026-10-22',
      text: '只在人格内部保留。',
      sourceCount: 1,
      createdAt: now,
    });
    const response = await app.request(`/api/persona-memory/diaries/${id}?account=${account}`, {
      method: 'PATCH',
      headers: jsonHeaders(),
      body: JSON.stringify({ visibleToAni: false }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { diary: { id: number; account: number; visibleToAni: boolean } };
    assert.deepEqual(body.diary, { id, account, visibleToAni: false });
    assert.equal(repository.listPersonaDiaries(account, 10).find((diary) => diary.id === id)?.visibleToAni, false);

    const crossAccount = await app.request(`/api/persona-memory/diaries/${id}?account=${account + 1}`, {
      method: 'PATCH',
      headers: jsonHeaders(),
      body: JSON.stringify({ visibleToAni: true }),
    });
    assert.equal(crossAccount.status, 400);
  });
});
