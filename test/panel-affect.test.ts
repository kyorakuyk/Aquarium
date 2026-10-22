import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionId } from '../src/core/shared/events.ts';
import { account, authHeaders, groupSession, now, withPanel } from './panel-test-helpers.ts';

function jsonHeaders(): HeadersInit {
  return { ...authHeaders(), 'Content-Type': 'application/json' };
}

test('心情 API 返回衰减后的值、档位与最近事件', async () => {
  await withPanel(async ({ app, repository }) => {
    assert.equal((await app.request('/api/mood')).status, 401);

    const baseline = await (await app.request('/api/mood', { headers: authHeaders() })).json() as {
      valence: number;
      arousal: number;
      band: string;
      bandSince: number | null;
      events: unknown[];
    };
    assert.equal(baseline.valence, 0.1);
    assert.equal(baseline.arousal, 0.4);
    assert.equal(baseline.band, 'calm');
    assert.equal(baseline.bandSince, null);
    assert.deepEqual(baseline.events, []);

    repository.saveMoodState({
      account,
      valence: 0.6,
      arousal: 0.9,
      updatedAt: now - 30 * 60_000,
      band: 'happy',
      bandSince: now - 3_600_000,
      lastBandChangeAt: now - 1_800_000,
    });
    repository.recordMoodEvent({
      account,
      time: now - 1_000,
      source: 'appraise',
      sessionId: sessionId(groupSession),
      senderId: 42,
      dv: 0.15,
      da: 0.1,
      appliedDv: 0.15,
      appliedDa: 0.1,
      reason: '被夸了',
      bandBefore: null,
      bandAfter: null,
      valenceAfter: 0.35,
      arousalAfter: 0.65,
    });

    const body = await (await app.request('/api/mood', { headers: authHeaders() })).json() as {
      valence: number;
      arousal: number;
      band: string;
      bandSince: number;
      events: Array<{ reason: string; source: string }>;
    };
    assert.ok(Math.abs(body.valence - 0.35) < 1e-9);
    assert.ok(Math.abs(body.arousal - 0.65) < 1e-9);
    assert.equal(body.band, 'happy');
    assert.equal(body.bandSince, now - 3_600_000);
    assert.equal(body.events.length, 1);
    assert.equal(body.events[0]?.reason, '被夸了');
    assert.equal(body.events[0]?.source, 'appraise');
  });
});

test('印象 API 返回群友名与全部状态标签', async () => {
  await withPanel(async ({ app, repository }) => {
    const key = sessionId(groupSession);
    const sensitiveTagText = 'sk-abc123def456ghi789';
    repository.insertTag({
      account,
      sessionId: key,
      userId: null,
      text: '爱聊游戏',
      norm: '爱聊游戏',
      category: 'misc',
      subject: null,
      polarity: null,
      origin: 'inferred',
      locked: false,
      status: 'confirmed',
      source: 'auto',
      samples: 3,
      evidence: [{ messageId: 'm1', time: now - 5_000, quote: '今晚开黑吗' }],
      firstSeen: now - 5_000,
      lastSeen: now - 5_000,
      supersededBy: null,
      updatedAt: now - 5_000,
    });
    repository.insertTag({
      account,
      sessionId: key,
      userId: 42,
      text: sensitiveTagText,
      norm: sensitiveTagText,
      category: 'misc',
      subject: null,
      polarity: null,
      origin: 'inferred',
      locked: false,
      status: 'candidate',
      source: 'auto',
      samples: 1,
      evidence: [],
      firstSeen: now - 1_000,
      lastSeen: now - 1_000,
      supersededBy: null,
      updatedAt: now - 1_000,
    });
    repository.insertTag({
      account,
      sessionId: key,
      userId: 42,
      text: '爱加班',
      norm: '爱加班',
      category: 'misc',
      subject: null,
      polarity: null,
      origin: 'inferred',
      locked: false,
      status: 'rejected',
      source: 'auto',
      samples: 2,
      evidence: [],
      firstSeen: now,
      lastSeen: now,
      supersededBy: null,
      updatedAt: now,
    });
    repository.insertTag({
      account,
      sessionId: key,
      userId: 42,
      text: sensitiveTagText,
      norm: sensitiveTagText,
      category: 'personality',
      subject: null,
      polarity: null,
      origin: 'inferred',
      locked: false,
      status: 'confirmed',
      source: 'auto',
      samples: 3,
      evidence: [],
      firstSeen: now,
      lastSeen: now,
      supersededBy: null,
      updatedAt: now,
    });
    repository.saveMessage({
      sessionId: key,
      messageId: 'name-1',
      senderId: 42,
      senderName: '12345678',
      isSelf: false,
      plainText: '晚上好',
      segments: [],
      time: now - 2_000,
    });

    const response = await app.request(`/api/impressions/${key}`, { headers: authHeaders() });
    assert.equal(response.status, 200);
    const body = await response.json() as {
      sessionId: string;
      groupTags: Array<{ text: string; status: string; activation: number; evidence: unknown[] }>;
      members: Array<{ userId: number; name: string; tags: Array<{ text: string; status: string }> }>;
    };
    assert.equal(body.sessionId, key);
    assert.equal(body.groupTags.length, 1);
    assert.equal(body.groupTags[0]?.text, '爱聊游戏');
    assert.ok((body.groupTags[0]?.activation ?? 0) > 0.99);
    assert.equal(body.groupTags[0]?.evidence.length, 1);
    assert.equal(body.members.length, 1);
    assert.equal(body.members[0]?.userId, 42);
    assert.equal(body.members[0]?.name, '12345678');
    assert.deepEqual(
      body.members[0]?.tags.map((tag) => [tag.text, tag.status]),
      [['[敏感内容已隐藏]', 'confirmed'], ['爱加班', 'rejected'], ['[敏感内容已隐藏]', 'candidate']],
    );

    assert.equal((await app.request('/api/impressions/not-a-session', { headers: authHeaders() })).status, 400);
  });
});

test('印象 API 原样返回群友名但继续脱敏标签正文与证据引文', async () => {
  await withPanel(async ({ app, repository }) => {
    const key = sessionId(groupSession);
    const fakeCredential = 'sk-abc123def456ghi789';
    repository.insertTag({
      account,
      sessionId: key,
      userId: null,
      text: fakeCredential,
      norm: fakeCredential,
      category: 'misc',
      subject: fakeCredential,
      polarity: null,
      origin: 'inferred',
      locked: false,
      status: 'confirmed',
      source: 'auto',
      samples: 1,
      evidence: [{ messageId: 'private-evidence', time: now, quote: `token=${fakeCredential}; ${fakeCredential}` }],
      firstSeen: now,
      lastSeen: now,
      supersededBy: null,
      updatedAt: now,
    });

    const response = await app.request(`/api/impressions/${key}`, { headers: authHeaders() });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.equal(body.includes(fakeCredential), false);
    assert.match(body, /\[敏感内容已隐藏\]/);
    assert.equal(body.split('[敏感内容已隐藏]').length - 1, 4);
  });
});

test('印象 API keeps signature evidence typed and redacts its text', async () => {
  await withPanel(async ({ app, repository }) => {
    const key = sessionId(groupSession);
    const credential = ['Q7m2P9x4', 'B8n5'].join('');
    repository.insertTag({
      account,
      sessionId: key,
      userId: 42,
      text: 'INTJ',
      norm: 'intj',
      category: 'identity',
      subject: null,
      polarity: null,
      origin: 'self_report',
      locked: false,
      status: 'confirmed',
      source: 'auto',
      samples: 1,
      evidence: [{ kind: 'signature', text: `token=${credential}`, fetchedAt: now }],
      firstSeen: now,
      lastSeen: now,
      supersededBy: null,
      updatedAt: now,
    });

    const response = await app.request(`/api/impressions/${key}`, { headers: authHeaders() });
    assert.equal(response.status, 200);
    const body = await response.json() as {
      members: Array<{ tags: Array<{ text: string; evidence: Array<Record<string, unknown>> }> }>;
    };
    const tag = body.members[0]?.tags[0];
    assert.equal(tag?.text, 'INTJ');
    assert.deepEqual(tag?.evidence[0], {
      kind: 'signature',
      text: '[敏感内容已隐藏]',
      fetchedAt: now,
    });
    assert.equal(JSON.stringify(body).includes(credential), false);
  });
});

test('群印象页读取 QQ 资料时缓存 24 小时，手动刷新会强制请求', async () => {
  await withPanel(async ({ app, adapter, repository }) => {
    const key = sessionId(groupSession);
    const calls = new Map<string, number>();
    const count = (name: string) => calls.set(name, (calls.get(name) ?? 0) + 1);
    adapter.getGroupInfo = async () => {
      count('group');
      return {
        groupName: '测试群', memberCount: 1, maxMemberCount: 200,
        groupCreateTime: Date.UTC(2021, 0, 1) / 1_000, groupLevel: 4, groupDescription: '夜间开黑',
      };
    };
    adapter.getGroupMembers = async () => {
      count('members');
      return [{
        userId: 42, nickname: '测试群友', card: '群名片', role: 'admin', title: '测试头衔',
        joinTime: Date.UTC(2021, 0, 1) / 1_000, lastSentTime: now / 1_000,
        level: '42', sex: 'female', age: 23, isRobot: false,
      }];
    };
    adapter.getGroupHonors = async () => { count('honors'); return []; };
    adapter.getStrangerInfo = async () => {
      count('stranger');
      return { longNick: 'INTJ', regTime: Date.UTC(2021, 0, 1) / 1_000 };
    };
    adapter.getGroupNoticeLatest = async () => { count('notice'); return '最新公告'; };
    adapter.getEssenceCount = async () => { count('essence'); return 2; };
    repository.saveMessage({
      sessionId: key,
      messageId: 'qq-profile-name',
      senderId: 42,
      senderName: '测试群友',
      isSelf: false,
      plainText: '晚上好',
      segments: [],
      time: now,
    });

    const getProfile = () => app.request(`/api/impressions/${key}`, { headers: authHeaders() });
    const firstResponse = await getProfile();
    assert.equal(firstResponse.status, 200);
    const first = await firstResponse.json() as {
      qqGroupProfile: {
        groupInfo: { groupName?: string; groupDescription?: string };
        honors: unknown[];
        latestNotice: string | null;
        essenceCount: number | null;
        composition: { sex: { female: number }; joinDuration: { overThreeYears: number } } | null;
      };
      members: Array<{ userId: number; qqProfile: { card?: string; role?: string; title?: string; qage?: number } }>;
    };
    assert.equal(first.qqGroupProfile.groupInfo.groupName, '测试群');
    assert.equal(first.qqGroupProfile.groupInfo.groupDescription, '夜间开黑');
    assert.deepEqual(first.qqGroupProfile.honors, []);
    assert.equal(first.qqGroupProfile.latestNotice, '最新公告');
    assert.equal(first.qqGroupProfile.essenceCount, 2);
    assert.deepEqual(first.qqGroupProfile.composition, {
      sex: { male: 0, female: 1, unknown: 0 },
      joinDuration: { overThreeYears: 1, oneToThreeYears: 0, withinOneYear: 0, unknown: 0 },
    });
    assert.equal(first.members[0]?.qqProfile.card, '群名片');
    assert.equal(first.members[0]?.qqProfile.role, 'admin');
    assert.equal(first.members[0]?.qqProfile.title, '测试头衔');
    assert.equal(first.members[0]?.qqProfile.qage, 5);
    assert.deepEqual([...calls.values()], [1, 1, 1, 1, 1, 1]);

    await getProfile();
    assert.deepEqual([...calls.values()], [1, 1, 1, 1, 1, 1]);
    const refreshResponse = await app.request(`/api/impressions/${key}/refresh-qq-profile`, {
      method: 'POST',
      headers: authHeaders(),
    });
    assert.equal(refreshResponse.status, 200);
    assert.deepEqual([...calls.values()], [2, 2, 2, 2, 2, 2]);
  });
});

test('标签 API：手动新增、改文字与改状态', async () => {
  await withPanel(async ({ app, repository }) => {
    const key = sessionId(groupSession);
    const createResponse = await app.request('/api/tags', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ sessionId: key, userId: null, text: ' 爱聊“游戏”！ ' }),
    });
    assert.equal(createResponse.status, 200);
    const created = await createResponse.json() as {
      id: number;
      text: string;
      status: string;
      source: string;
      samples: number;
      category: string;
      origin: string;
      locked: boolean;
    };
    assert.equal(created.source, 'manual');
    assert.equal(created.status, 'confirmed');
    assert.equal(created.text, ' 爱聊“游戏”！ ');
    assert.equal(created.category, 'misc');
    assert.equal(created.origin, 'manual');
    assert.equal(created.locked, false);
    const stored = repository.tagById(created.id);
    assert.equal(stored?.norm, '爱聊游戏');
    assert.equal(stored?.userId, null);
    assert.equal(stored?.samples, 1);

    assert.equal((await app.request('/api/tags', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ sessionId: key, userId: null, text: '短' }),
    })).status, 400);

    const patchResponse = await app.request(`/api/tags/${created.id}`, {
      method: 'PATCH',
      headers: jsonHeaders(),
      body: JSON.stringify({ text: '改过的标签', status: 'candidate' }),
    });
    assert.equal(patchResponse.status, 200);
    const patched = await patchResponse.json() as { text: string; status: string; samples: number };
    assert.equal(patched.text, '改过的标签');
    assert.equal(patched.status, 'candidate');
    assert.equal(patched.samples, created.samples);
    const after = repository.tagById(created.id);
    assert.equal(after?.norm, '改过的标签');
    assert.equal(after?.samples, stored?.samples);

    assert.equal((await app.request(`/api/tags/${created.id}`, {
      method: 'PATCH',
      headers: jsonHeaders(),
      body: JSON.stringify({ status: 'superseded' }),
    })).status, 400);
    assert.equal((await app.request('/api/tags/9999', {
      method: 'PATCH',
      headers: jsonHeaders(),
      body: JSON.stringify({ status: 'rejected' }),
    })).status, 404);
  });
});

test('好感 API 按全局用户读取回落值与事件，并手动设置档位', async () => {
  await withPanel(async ({ app, repository }) => {
    const unseenResponse = await app.request('/api/affinity/99', { headers: authHeaders() });
    assert.equal(unseenResponse.status, 200);
    const unseen = await unseenResponse.json() as { value: number; lastInteractionAt: number | null };
    assert.equal(unseen.value, 50);
    assert.equal(unseen.lastInteractionAt, null);

    const lastInteractionAt = now - 5 * 24 * 60 * 60 * 1000;
    repository.saveAffinityState({
      account,
      userId: 42,
      value: 72,
      level: 'warm',
      levelSince: lastInteractionAt - 10 * 24 * 60 * 60 * 1000,
      lastLevelChangeAt: lastInteractionAt - 10 * 24 * 60 * 60 * 1000,
      lastInteractionAt,
      updatedAt: lastInteractionAt,
    });
    repository.recordAffinityEvent({
      account,
      userId: 42,
      time: lastInteractionAt,
      source: 'appraise',
      sessionId: sessionId(groupSession),
      delta: 2,
      applied: 2,
      reason: '正向情绪 token=K9m4R2p8T1v6',
      levelBefore: null,
      levelAfter: null,
    });
    const saveName = (messageId: string, senderName: string, time: number, kind: 'group' | 'private') => {
      repository.saveMessage({
        sessionId: sessionId({ account, kind, peer: kind === 'group' ? groupSession.peer : 42 }),
        messageId,
        senderId: 42,
        senderName,
        isSelf: false,
        plainText: '测试消息',
        segments: [],
        time,
      });
    };
    saveName('affinity-name-old', '旧名字', now - 1_000, 'group');
    saveName('affinity-name-new', 'MemberName123', now - 500, 'private');

    const listResponse = await app.request('/api/affinity', { headers: authHeaders() });
    assert.equal(listResponse.status, 200);
    const people = await listResponse.json() as Array<{
      userId: number;
      name: string;
      value: number;
      level: string;
      lastInteractionAt: number | null;
    }>;
    assert.deepEqual(people, [{ userId: 42, name: 'MemberName123', value: 70, level: 'warm', lastInteractionAt }]);

    const detailResponse = await app.request('/api/affinity/42', { headers: authHeaders() });
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json() as { events: Array<{ reason: string }> };
    assert.equal(detail.events.length, 1);
    assert.equal(detail.events[0]?.reason, '正向情绪 [敏感内容已隐藏]');

    const updateResponse = await app.request('/api/affinity/42', {
      method: 'PATCH',
      headers: jsonHeaders(),
      body: JSON.stringify({ value: 10 }),
    });
    assert.equal(updateResponse.status, 200);
    const updated = repository.getAffinityState(account, 42);
    assert.equal(updated?.value, 10);
    assert.equal(updated?.level, 'cold');
    assert.equal(updated?.lastInteractionAt, lastInteractionAt);
    assert.equal(repository.recentAffinityEvents(account, 42, 1)[0]?.source, 'manual');

    const invalidUpdate = await app.request('/api/affinity/42', {
      method: 'PATCH',
      headers: jsonHeaders(),
      body: JSON.stringify({ value: 101 }),
    });
    assert.equal(invalidUpdate.status, 400);
    assert.equal((await app.request('/api/affinity/not-a-user', { headers: authHeaders() })).status, 400);
  });
});
