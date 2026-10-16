import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionId } from '../src/core/events.ts';
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

test('印象 API 返回群标签、成员名与全部状态标签', async () => {
  await withPanel(async ({ app, repository }) => {
    const key = sessionId(groupSession);
    repository.insertTag({
      account,
      sessionId: key,
      userId: null,
      text: '爱聊游戏',
      norm: '爱聊游戏',
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
      text: '夜猫子',
      norm: '夜猫子',
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
      status: 'rejected',
      source: 'auto',
      samples: 2,
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
      senderName: '小明',
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
    assert.equal(body.members[0]?.name, '小明');
    assert.deepEqual(
      body.members[0]?.tags.map((tag) => [tag.text, tag.status]),
      [['爱加班', 'rejected'], ['夜猫子', 'candidate']],
    );

    assert.equal((await app.request('/api/impressions/not-a-session', { headers: authHeaders() })).status, 400);
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
    const created = await createResponse.json() as { id: number; text: string; status: string; source: string; samples: number };
    assert.equal(created.source, 'manual');
    assert.equal(created.status, 'confirmed');
    assert.equal(created.text, ' 爱聊“游戏”！ ');
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
