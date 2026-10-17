import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveSession } from '../src/config/resolve.ts';
import { sessionId } from '../src/core/events.ts';
import {
  account,
  authHeaders,
  exampleConfig,
  groupSession,
  withPanel,
} from './panel-test-helpers.ts';

test('全局默认 API 可读取、部分更新并拒绝 null 或无效值', async () => {
  await withPanel(async ({ app, getConfig }) => {
    const initialResponse = await app.request('/api/defaults', { headers: authHeaders() });
    assert.equal(initialResponse.status, 200);
    assert.deepEqual(await initialResponse.json(), getConfig().defaults);

    const patchResponse = await app.request('/api/defaults', {
      method: 'PATCH',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        groupNote: '新的全局说明',
        rate: { perUserPerMinute: 11 },
        modeSchedule: [{ from: '08:00', to: '12:00', mode: 'active' }],
      }),
    });
    assert.equal(patchResponse.status, 200);
    assert.equal(getConfig().defaults.groupNote, '新的全局说明');
    assert.equal(getConfig().defaults.rate.perUserPerMinute, 11);
    assert.equal(getConfig().defaults.rate.perSessionPerMinute, exampleConfig.defaults.rate.perSessionPerMinute);
    assert.deepEqual(getConfig().defaults.modeSchedule, [{ from: '08:00', to: '12:00', mode: 'active' }]);

    const updatedResponse = await app.request('/api/defaults', { headers: authHeaders() });
    assert.deepEqual(await updatedResponse.json(), getConfig().defaults);

    const invalidBodies = [
      { groupNote: null },
      { modeSchedule: [{ from: '24:00', to: '12:00', mode: 'active' }] },
      { unsupported: true },
    ];
    for (const body of invalidBodies) {
      const response = await app.request('/api/defaults', {
        method: 'PATCH',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 400);
    }
    assert.equal(getConfig().defaults.groupNote, '新的全局说明');
  });
});

test('主动冷却可从全局默认继承、按群覆盖并恢复继承', async () => {
  await withPanel(async ({ app, getConfig }) => {
    assert.equal(getConfig().defaults.proactiveCooldownSec, 120);

    const globalUpdate = await app.request('/api/defaults', {
      method: 'PATCH',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ proactiveCooldownSec: 240 }),
    });
    assert.equal(globalUpdate.status, 200);
    assert.equal(getConfig().defaults.proactiveCooldownSec, 240);
    const globalReadback = await app.request('/api/defaults', { headers: authHeaders() });
    assert.equal((await globalReadback.json() as { proactiveCooldownSec: number }).proactiveCooldownSec, 240);

    const id = sessionId(groupSession);
    const sessionUpdate = await app.request(`/api/sessions/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ proactiveCooldownSec: 15 }),
    });
    assert.equal(sessionUpdate.status, 200);
    assert.equal(resolveSession(getConfig(), groupSession).proactiveCooldownSec, 15);
    const sessionsReadback = await app.request('/api/sessions', { headers: authHeaders() });
    const sessions = await sessionsReadback.json() as Array<{
      sessionId: string;
      effective: { proactiveCooldownSec: number };
    }>;
    assert.equal(sessions.find((session) => session.sessionId === id)?.effective.proactiveCooldownSec, 15);

    const invalidValues = [-1, 3601, 1.5];
    for (const value of invalidValues) {
      const response = await app.request(`/api/sessions/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ proactiveCooldownSec: value }),
      });
      assert.equal(response.status, 400);
    }

    const inherited = await app.request(`/api/sessions/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ proactiveCooldownSec: null }),
    });
    assert.equal(inherited.status, 200);
    assert.equal(resolveSession(getConfig(), groupSession).proactiveCooldownSec, 240);
    const inheritedReadback = await app.request('/api/sessions', { headers: authHeaders() });
    const inheritedSessions = await inheritedReadback.json() as typeof sessions;
    assert.equal(inheritedSessions.find((session) => session.sessionId === id)?.effective.proactiveCooldownSec, 240);
  });
});

test('talkOffset 可从全局默认继承、按群覆盖并恢复继承', async () => {
  await withPanel(async ({ app, getConfig }) => {
    assert.equal(getConfig().defaults.talkOffset, 0);
    const globalUpdate = await app.request('/api/defaults', {
      method: 'PATCH',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ talkOffset: 1 }),
    });
    assert.equal(globalUpdate.status, 200);
    assert.equal(getConfig().defaults.talkOffset, 1);

    const id = sessionId(groupSession);
    const sessionUpdate = await app.request(`/api/sessions/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ talkOffset: -2 }),
    });
    assert.equal(sessionUpdate.status, 200);
    assert.equal(resolveSession(getConfig(), groupSession).talkOffset, -2);
    const sessionsReadback = await app.request('/api/sessions', { headers: authHeaders() });
    const sessions = await sessionsReadback.json() as Array<{
      sessionId: string;
      overrides: string[];
      effective: { talkOffset: number };
    }>;
    const group = sessions.find((session) => session.sessionId === id);
    assert.equal(group?.effective.talkOffset, -2);
    assert.ok(group?.overrides.includes('talkOffset'));

    for (const value of [-3, 3, 1.5]) {
      const invalid = await app.request(`/api/sessions/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ talkOffset: value }),
      });
      assert.equal(invalid.status, 400);
    }

    const inherited = await app.request(`/api/sessions/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ talkOffset: null }),
    });
    assert.equal(inherited.status, 200);
    assert.equal(resolveSession(getConfig(), groupSession).talkOffset, 1);
  });
});

test('会话 API 返回最近消息时间，并优先排列启用且最近活跃的会话', async () => {
  await withPanel(async ({ app, repository, adapter }) => {
    const groups = [
      { groupId: groupSession.peer, name: '较旧群', memberCount: 4 },
      { groupId: 234567, name: '较新群', memberCount: 5 },
      { groupId: 345678, name: '停用但活跃群', memberCount: 6 },
      { groupId: 456789, name: 'A无消息群', memberCount: 7 },
      { groupId: 567890, name: 'B无消息群', memberCount: 8 },
    ];
    adapter.groups = groups;

    const ids = groups.map((group) => sessionId({ account, kind: 'group', peer: group.groupId }));
    const disableResponse = await app.request(`/api/sessions/${encodeURIComponent(ids[2]!)}`, {
      method: 'PATCH',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(disableResponse.status, 200);

    const saveMessage = (id: string, messageId: string, time: number) => repository.saveMessage({
      sessionId: id,
      messageId,
      senderId: 7,
      senderName: '测试发送者',
      isSelf: false,
      plainText: messageId,
      segments: [],
      time,
    });
    saveMessage(ids[0]!, 'older', 100);
    saveMessage(ids[0]!, 'latest', 300);
    saveMessage(ids[1]!, 'newest-enabled', 500);
    saveMessage(ids[2]!, 'newest-disabled', 900);

    const response = await app.request('/api/sessions', { headers: authHeaders() });
    assert.equal(response.status, 200);
    const sessions = await response.json() as Array<{
      sessionId: string;
      kind: 'group' | 'private';
      enabled: boolean;
      lastMessageAt: number | null;
    }>;
    const listedGroups = sessions.filter((session) => session.kind === 'group');
    assert.deepEqual(listedGroups.map(({ sessionId: id, enabled, lastMessageAt }) => ({ id, enabled, lastMessageAt })), [
      { id: ids[1], enabled: true, lastMessageAt: 500 },
      { id: ids[0], enabled: true, lastMessageAt: 300 },
      { id: ids[3], enabled: true, lastMessageAt: null },
      { id: ids[4], enabled: true, lastMessageAt: null },
      { id: ids[2], enabled: false, lastMessageAt: 900 },
    ]);
    assert.equal(sessions.find((session) => session.kind === 'private')?.lastMessageAt, null);
  });
});

test('会话 API 过滤机器人自身与设备联系人但保留配置覆盖', async () => {
  await withPanel(async ({ app, adapter, getConfig }) => {
    adapter.friends = [
      { userId: account, nickname: 'Aquarium Bot' },
      { userId: 111, nickname: '我的手机' },
      { userId: 112, nickname: '设备', remark: '我的Pad' },
      { userId: 113, nickname: '我的平板' },
      { userId: 114, nickname: '我的平板电脑' },
    ];
    const preservedOverrideId = sessionId({ account, kind: 'private', peer: 111 });
    const overrideResponse = await app.request(`/api/sessions/${encodeURIComponent(preservedOverrideId)}`, {
      method: 'PATCH',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupNote: '保留但不展示' }),
    });
    assert.equal(overrideResponse.status, 200);

    const response = await app.request('/api/sessions', { headers: authHeaders() });
    assert.equal(response.status, 200);
    const sessions = await response.json() as Array<{ sessionId: string; kind: 'group' | 'private' }>;
    const listedPrivateIds = sessions.filter((session) => session.kind === 'private').map((session) => session.sessionId);
    assert.deepEqual(listedPrivateIds, [sessionId({ account, kind: 'private', peer: 114 })]);
    assert.equal(getConfig().sessions[preservedOverrideId]?.groupNote, '保留但不展示');
  });
});

test('联系人读取失败时仍隐藏配置中的本账号私聊', async () => {
  await withPanel(async ({ app, adapter, getConfig }) => {
    const selfId = sessionId({ account, kind: 'private', peer: account });
    const overrideResponse = await app.request(`/api/sessions/${encodeURIComponent(selfId)}`, {
      method: 'PATCH',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupNote: '保留的自身会话覆盖' }),
    });
    assert.equal(overrideResponse.status, 200);
    adapter.friendListFails = true;

    const response = await app.request('/api/sessions', { headers: authHeaders() });
    assert.equal(response.status, 200);
    const sessions = await response.json() as Array<{ sessionId: string }>;
    assert.equal(sessions.some((session) => session.sessionId === selfId), false);
    assert.equal(getConfig().sessions[selfId]?.groupNote, '保留的自身会话覆盖');
  });
});
