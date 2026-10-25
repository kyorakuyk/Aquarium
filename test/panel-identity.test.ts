import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sessionId } from '../src/core/shared/events.ts';
import { account, authHeaders, groupSession, now, withPanel } from './panel-test-helpers.ts';

function jsonHeaders(): HeadersInit {
  return { ...authHeaders(), 'Content-Type': 'application/json' };
}

function memberTag(userId: number, text: string, evidenceId: string) {
  return {
    account,
    sessionId: sessionId(groupSession),
    userId,
    text,
    norm: text,
    category: 'personality' as const,
    subject: null,
    polarity: null,
    origin: 'inferred' as const,
    locked: false,
    status: 'confirmed' as const,
    source: 'auto' as const,
    samples: 1,
    evidence: [{ messageId: evidenceId, time: now, quote: text }],
    firstSeen: now,
    lastSeen: now,
    supersededBy: null,
    updatedAt: now,
  };
}

test('QQ 标记机器人只显示建议；身份 kind 通过手动 API 写入并 read-back', async () => {
  await withPanel(async ({ app, repository }) => {
    const key = sessionId(groupSession);
    repository.saveMessage({
      sessionId: key,
      messageId: 'identity-member',
      senderId: 42,
      senderName: '小明',
      isSelf: false,
      plainText: '我会帮忙',
      segments: [{ type: 'text', text: '我会帮忙' }],
      time: now,
    });
    repository.insertTag(memberTag(42, '热心助人', 'identity-member'));
    repository.saveQqGroupProfile({
      account,
      groupId: groupSession.peer,
      json: JSON.stringify({ groupInfo: null, honors: null, latestNotice: null, essenceCount: null, membersAvailable: true }),
      fetchedAt: now,
    });
    repository.replaceQqMemberProfiles(account, groupSession.peer, [{
      account,
      groupId: groupSession.peer,
      userId: 42,
      json: JSON.stringify({ userId: 42, nickname: '小明', isRobot: true }),
      fetchedAt: now,
    }]);

    const url = `/api/impressions/${encodeURIComponent(key)}`;
    const before = await (await app.request(url, { headers: authHeaders() })).json() as {
      members: Array<{ userId: number; kind: string | null; qqProfile: { isRobot?: boolean } | null }>;
    };
    assert.equal(before.members.find((member) => member.userId === 42)?.kind, null);
    assert.equal(before.members.find((member) => member.userId === 42)?.qqProfile?.isRobot, true);
    assert.equal(repository.getAccountKind(account, 42), undefined);

    const response = await app.request(`/api/identity/${encodeURIComponent(key)}/42/kind`, {
      method: 'PATCH',
      headers: jsonHeaders(),
      body: JSON.stringify({ kind: 'bot' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { userId: 42, kind: 'bot' });
    assert.equal(repository.getAccountKind(account, 42)?.kind, 'bot');

    const after = await (await app.request(url, { headers: authHeaders() })).json() as {
      members: Array<{ userId: number; kind: string | null; memberTagsText: string | null }>;
    };
    assert.equal(after.members.find((member) => member.userId === 42)?.kind, 'bot');
    assert.match(after.members.find((member) => member.userId === 42)?.memberTagsText ?? '', /小明（bot）/u);
  });
});

test('关系 API 支持双向关系、锁定 read-back 和小号标签单向合并', async () => {
  await withPanel(async ({ app, repository }) => {
    const key = sessionId(groupSession);
    for (const [userId, name] of [[42, '主号昵称'], [43, '小号昵称']] as const) {
      repository.saveMessage({
        sessionId: key,
        messageId: `relation-${userId}`,
        senderId: userId,
        senderName: name,
        isSelf: false,
        plainText: '消息',
        segments: [{ type: 'text', text: '消息' }],
        time: now,
      });
    }
    const mainTagId = repository.insertTag(memberTag(42, '热爱棋类', 'main-tag'));
    const altTagId = repository.insertTag(memberTag(43, '热爱棋类', 'alt-tag'));
    const endpoint = `/api/identity/${encodeURIComponent(key)}/42/relations`;

    const siblingResponse = await app.request(endpoint, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ targetUserId: 43, type: 'brother' }),
    });
    assert.equal(siblingResponse.status, 201);
    const sibling = await siblingResponse.json() as { id: number };
    const lockResponse = await app.request(`${endpoint}/${sibling.id}`, {
      method: 'PATCH',
      headers: jsonHeaders(),
      body: JSON.stringify({ locked: true }),
    });
    assert.equal(lockResponse.status, 200);
    assert.equal((await lockResponse.json() as { locked: boolean }).locked, true);

    const altResponse = await app.request(endpoint, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ targetUserId: 43, type: 'alt', currentRole: 'main' }),
    });
    assert.equal(altResponse.status, 201);
    const alt = await altResponse.json() as { id: number; type: string };
    assert.equal(alt.type, 'alt');
    assert.equal(repository.mainUserIdFor(account, 43), 42);
    assert.equal(repository.getAccountKind(account, 43)?.kind, 'alt');
    assert.equal(repository.tagById(altTagId)?.status, 'superseded');
    assert.equal(repository.tagById(altTagId)?.supersededBy, mainTagId);
    assert.equal(repository.listTagsForSubject(account, key, 42).find((tag) => tag.id === mainTagId)?.samples, 2);

    const removeResponse = await app.request(`${endpoint}/${alt.id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    assert.equal(removeResponse.status, 200);
    assert.equal(repository.mainUserIdFor(account, 43), 43);
    assert.equal(repository.tagById(mainTagId)?.userId, 42);
    assert.equal(repository.tagById(altTagId)?.status, 'superseded');
  });
});

test('原作对象 API 精确绑定 QQ、清除 claim 并 read-back dismissed 状态', async () => {
  await withPanel(async ({ app, repository, root }) => {
    fs.writeFileSync(path.join(root, 'personas', 'default.md'), [
      '---',
      'counterparts:',
      '  - name: 岛村抱月',
      '    aliases: [岛村, 抱月]',
      '    label: 恋人',
      '    matchByName: prompt',
      '---',
      '角色卡。',
    ].join('\n'), 'utf8');
    const query = `?account=${account}`;
    const endpoint = `/api/personas/default/counterparts${query}`;
    const initialResponse = await app.request(endpoint, { headers: authHeaders() });
    assert.equal(initialResponse.status, 200);
    const initial = await initialResponse.json() as {
      counterparts: Array<{ name: string; aliases: string[]; label: string; matchByName: string }>;
      bindings: unknown[];
      claims: unknown[];
    };
    assert.deepEqual(initial.counterparts, [{
      name: '岛村抱月', aliases: ['岛村', '抱月'], label: '恋人', matchByName: 'prompt',
    }]);
    assert.deepEqual(initial.bindings, []);
    assert.deepEqual(initial.claims, []);

    repository.upsertPersonaCounterpartClaim({
      account,
      personaId: 'default',
      counterpartName: '岛村抱月',
      userId: 43,
      sessionId: sessionId(groupSession),
      evidence: '消息：我是岛村',
      firstSeen: now - 1_000,
      lastSeen: now,
    });
    const refreshedClaim = repository.upsertPersonaCounterpartClaim({
      account,
      personaId: 'default',
      counterpartName: '岛村抱月',
      userId: 43,
      sessionId: sessionId(groupSession),
      evidence: '消息：我是岛村，第二次出现',
      firstSeen: now,
      lastSeen: now + 1_000,
    });
    assert.equal(refreshedClaim.firstSeen, now - 1_000);
    assert.equal(refreshedClaim.lastSeen, now + 1_000);
    const bindResponse = await app.request(
      `/api/personas/default/counterparts/${encodeURIComponent('岛村抱月')}/bindings${query}`,
      { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ userId: 43 }) },
    );
    assert.equal(bindResponse.status, 201);
    assert.deepEqual(await bindResponse.json(), {
      account,
      personaId: 'default',
      counterpartName: '岛村抱月',
      userId: 43,
      createdAt: now,
    });
    assert.equal(repository.listPersonaCounterpartBindings(account, 'default')[0]?.userId, 43);
    assert.deepEqual(repository.listPersonaCounterpartClaims(account, 'default'), []);
    const secondBindResponse = await app.request(
      `/api/personas/default/counterparts/${encodeURIComponent('岛村抱月')}/bindings${query}`,
      { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ userId: 44 }) },
    );
    assert.equal(secondBindResponse.status, 201);
    assert.deepEqual(repository.listPersonaCounterpartBindings(account, 'default').map(({ userId }) => userId), [43, 44]);

    repository.upsertPersonaCounterpartClaim({
      account,
      personaId: 'default',
      counterpartName: '岛村抱月',
      userId: 46,
      sessionId: sessionId(groupSession),
      evidence: '昵称含 岛村',
      firstSeen: now,
      lastSeen: now,
    });
    const dismissResponse = await app.request(
      `/api/personas/default/counterparts/${encodeURIComponent('岛村抱月')}/claims/46/dismiss${query}`,
      { method: 'POST', headers: authHeaders() },
    );
    assert.equal(dismissResponse.status, 200);
    assert.equal((await dismissResponse.json() as { status: string }).status, 'dismissed');
    const dismissedClaim = repository.listPersonaCounterpartClaims(account, 'default')[0];
    const repeatedClaim = repository.upsertPersonaCounterpartClaim({
      account,
      personaId: 'default',
      counterpartName: '岛村抱月',
      userId: 46,
      sessionId: sessionId(groupSession),
      evidence: '新的昵称证据',
      firstSeen: now,
      lastSeen: now + 2_000,
    });
    assert.deepEqual(repeatedClaim, dismissedClaim);
    assert.equal(repository.listPersonaCounterpartClaims(account, 'default')[0]?.status, 'dismissed');

    const deleteResponse = await app.request(
      `/api/personas/default/counterparts/${encodeURIComponent('岛村抱月')}/bindings/43${query}`,
      { method: 'DELETE', headers: authHeaders() },
    );
    assert.equal(deleteResponse.status, 200);
    assert.deepEqual(repository.listPersonaCounterpartBindings(account, 'default').map(({ userId }) => userId), [44]);
  });
});

test('成员画像只展示该精确 QQ 的待认领记录，不把小号 claim 合并到主号', async () => {
  await withPanel(async ({ app, repository, root, getConfig }) => {
    const personaId = getConfig().accounts.find(({ uin }) => uin === account)?.persona ?? 'default';
    fs.writeFileSync(path.join(root, 'personas', `${personaId}.md`), [
      '---',
      'counterparts:',
      '  - name: 岛村抱月',
      '    aliases: [岛村]',
      '    label: 恋人',
      '---',
      '角色卡。',
    ].join('\n'), 'utf8');
    const key = sessionId(groupSession);
    for (const [userId, senderName] of [[42, '正常同学'], [43, '岛村']] as const) {
      repository.saveMessage({
        sessionId: key,
        messageId: `counterpart-impressions-${userId}`,
        senderId: userId,
        senderName,
        isSelf: false,
        plainText: '普通发言',
        segments: [{ type: 'text', text: '普通发言' }],
        time: now,
      });
    }
    repository.linkAltAccount({ account, aUserId: 42, bUserId: 43, createdAt: now });
    for (const userId of [42, 43]) {
      repository.upsertPersonaCounterpartClaim({
        account,
        personaId,
        counterpartName: '岛村抱月',
        userId,
        sessionId: key,
        evidence: '昵称含 岛村',
        firstSeen: now,
        lastSeen: now,
      });
    }

    const response = await app.request(`/api/impressions/${encodeURIComponent(key)}`, { headers: authHeaders() });
    assert.equal(response.status, 200);
    const view = await response.json() as {
      members: Array<{ userId: number; counterpartClaims?: Array<{ userId: number; senderName: string }> }>;
    };
    const main = view.members.find((member) => member.userId === 42);
    assert.deepEqual(main?.counterpartClaims?.map(({ userId, senderName }) => [userId, senderName]), [
      [42, '正常同学'],
    ]);
  });
});
