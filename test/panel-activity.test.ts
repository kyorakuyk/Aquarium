import assert from 'node:assert/strict';
import test from 'node:test';
import { createRepository } from '../src/store/repository.ts';
import { createActivitySuggestionRepository } from '../src/store/activity-suggestion-repo.ts';
import { openDatabase } from '../src/store/db.ts';
import { createProfileActivityService } from '../src/core/profiles/presence-service.ts';
import { sessionId, type SessionKey } from '../src/core/shared/events.ts';
import { createPanelApp } from '../src/panel-server/app.ts';
import { makeConfig } from './pipeline-test-helpers.ts';

const password = 'test-panel-password';
const headers = { Authorization: `Bearer ${password}` };

function activityFixture() {
  const database = openDatabase(':memory:');
  const repository = createRepository(database);
  const suggestionRepository = createActivitySuggestionRepository(database);
  const base = makeConfig();
  const session: SessionKey = { account: base.accounts[0]!.uin, kind: 'group', peer: 99123 };
  const id = sessionId(session);
  let config = makeConfig({ sessions: { [id]: { enabled: true } } });
  let now = new Date(2026, 5, 10, 22, 0, 0, 0).getTime();
  const profileActivity = createProfileActivityService({
    repository,
    suggestionRepository,
    getConfig: () => config,
    now: () => now,
  });
  const app = createPanelApp({
    password,
    getConfig: () => config,
    saveConfig: (next) => { config = next; },
    repository,
    accounts: () => [],
    management: () => [],
    profileActivity,
    now: () => now,
  });
  for (let index = 0; index < 50; index += 1) {
    const time = new Date(now);
    time.setDate(time.getDate() - index);
    time.setHours(20, 10, 0, 0);
    repository.saveMessage({
      sessionId: id,
      messageId: `activity-${index}`,
      senderId: 42,
      senderName: '好友',
      isSelf: false,
      plainText: '晚间发言',
      segments: [{ type: 'text', text: '晚间发言' }],
      time: time.getTime(),
    });
  }
  return {
    app,
    config: () => config,
    database,
    id,
    repository,
    setNow: (value: number) => { now = value; },
    getNow: () => now,
  };
}

test('群活动接口返回本地统计，并在建议关闭后 30 天重新显示', async () => {
  const fixture = activityFixture();
  try {
    const url = `/api/activity?sessionId=${encodeURIComponent(fixture.id)}&view=hour`;
    const initialResponse = await fixture.app.request(url, { headers });
    assert.equal(initialResponse.status, 200);
    const initial = await initialResponse.json() as {
      view: string;
      buckets: number[];
      summary: { total: number };
      suggestion: { from: string; to: string; windowKey: string } | null;
    };
    assert.equal(initial.view, 'hour');
    assert.equal(initial.summary.total, 50);
    assert.equal(initial.buckets.length, 24);
    assert.equal(initial.suggestion?.from, '18:00');
    assert.equal(initial.suggestion?.to, '21:00');

    for (const [view, expectedBuckets] of [['week', 7], ['month', 30], ['year', 365]] as const) {
      const response = await fixture.app.request(
        `/api/activity?sessionId=${encodeURIComponent(fixture.id)}&view=${view}`,
        { headers },
      );
      const activity = await response.json() as { buckets: unknown[] };
      assert.equal(activity.buckets.length, expectedBuckets);
    }

    const memberResponse = await fixture.app.request(`${url}&userId=42`, { headers });
    const member = await memberResponse.json() as { summary: { total: number } };
    assert.equal(member.summary.total, 50);

    const lowSessionId = sessionId({
      account: fixture.config().accounts[0]!.uin,
      kind: 'group',
      peer: 99124,
    });
    for (let dayOffset = 1; dayOffset <= 4; dayOffset += 1) {
      for (let hour = 0; hour < 24; hour += 1) {
        const time = new Date(fixture.getNow());
        time.setDate(time.getDate() - dayOffset);
        time.setHours(hour, 5, 0, 0);
        fixture.repository.saveMessage({
          sessionId: lowSessionId,
          messageId: `balanced-${dayOffset}-${hour}`,
          senderId: 42,
          senderName: '好友',
          isSelf: false,
          plainText: '发言',
          segments: [{ type: 'text', text: '发言' }],
          time: time.getTime(),
        });
      }
    }
    const lowActivityResponse = await fixture.app.request(
      `/api/activity?sessionId=${encodeURIComponent(lowSessionId)}&view=hour`,
      { headers },
    );
    const lowActivity = await lowActivityResponse.json() as { suggestion: unknown };
    assert.equal(lowActivity.suggestion, null);

    const dismissResponse = await fixture.app.request('/api/activity/suggestion/dismiss', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: fixture.id, windowKey: initial.suggestion?.windowKey }),
    });
    assert.equal(dismissResponse.status, 200);

    fixture.setNow(fixture.getNow() + 30 * 24 * 60 * 60 * 1000 - 1);
    const suppressedResponse = await fixture.app.request(url, { headers });
    const suppressed = await suppressedResponse.json() as { suggestion: unknown };
    assert.equal(suppressed.suggestion, null);

    fixture.setNow(fixture.getNow() + 1);
    const expiredResponse = await fixture.app.request(url, { headers });
    const expired = await expiredResponse.json() as { suggestion: { windowKey: string } | null };
    assert.equal(expired.suggestion?.windowKey, initial.suggestion?.windowKey);
  } finally {
    fixture.database.close();
  }
});

test('采纳群活动建议会保存优先生效的 active 时间段', async () => {
  const fixture = activityFixture();
  try {
    const url = `/api/activity?sessionId=${encodeURIComponent(fixture.id)}&view=hour`;
    const initialResponse = await fixture.app.request(url, { headers });
    const initial = await initialResponse.json() as {
      suggestion: { from: string; to: string; windowKey: string } | null;
    };
    assert.ok(initial.suggestion);

    const applyResponse = await fixture.app.request('/api/activity/suggestion/apply', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: fixture.id, windowKey: initial.suggestion.windowKey }),
    });
    assert.equal(applyResponse.status, 200);
    const override = fixture.config().sessions[fixture.id];
    assert.equal(override?.modeSchedule?.[0]?.from, initial.suggestion.from);
    assert.equal(override?.modeSchedule?.[0]?.to, initial.suggestion.to);
    assert.equal(override?.modeSchedule?.[0]?.mode, 'active');

    const afterResponse = await fixture.app.request(url, { headers });
    const after = await afterResponse.json() as { suggestion: unknown };
    assert.equal(after.suggestion, null);
  } finally {
    fixture.database.close();
  }
});
