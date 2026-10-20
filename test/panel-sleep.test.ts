import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionId } from '../src/core/shared/events.ts';
import { account, authHeaders, groupSession, now, withPanel } from './panel-test-helpers.ts';

const jsonHeaders = { ...authHeaders(), 'Content-Type': 'application/json' };

async function patchSleep(app: { request: (input: string, init?: RequestInit) => Promise<Response> }, body: unknown) {
  return app.request('/api/sleep', {
    method: 'PATCH',
    headers: jsonHeaders,
    body: JSON.stringify(body),
  });
}

test('sleep API returns safe defaults, partially patches settings, and rejects invalid fields', async () => {
  await withPanel(async ({ app, getConfig }) => {
    const initialResponse = await app.request('/api/sleep', { headers: authHeaders() });
    assert.equal(initialResponse.status, 200);
    const initial = await initialResponse.json() as {
      enabled: boolean;
      bedtime: string;
      wake: string;
      goodnight: boolean;
      status: string;
      energy: number | null;
      nextChangeAt: number | null;
      account: number | null;
    };
    assert.deepEqual({
      enabled: initial.enabled,
      bedtime: initial.bedtime,
      wake: initial.wake,
      goodnight: initial.goodnight,
      status: initial.status,
      energy: initial.energy,
      nextChangeAt: initial.nextChangeAt,
      account: initial.account,
    }, {
      enabled: false,
      bedtime: '02:00',
      wake: '09:00',
      goodnight: true,
      status: 'awake',
      energy: 1,
      nextChangeAt: null,
      account,
    });

    const patch = await patchSleep(app, { enabled: true, bedtime: '22:00', goodnight: false });
    assert.equal(patch.status, 200);
    assert.deepEqual(getConfig().sleep, {
      enabled: true,
      bedtime: '22:00',
      wake: '09:00',
      wakeWords: ['起床', '醒醒', '别睡了'],
      goodnight: false,
    });
    const readback = await app.request('/api/sleep', { headers: authHeaders() });
    assert.equal((await readback.json() as { bedtime: string }).bedtime, '22:00');

    for (const body of [
      { bedtime: '24:00' },
      { wake: '7:00' },
      { enabled: null },
      { wakeWords: ['自定义'] },
      { unsupported: true },
    ]) {
      const response = await patchSleep(app, body);
      assert.equal(response.status, 400);
    }
    assert.equal(getConfig().sleep.bedtime, '22:00');
  });
});

test('sleep status and energy use schedule, recent replies, and the in-memory wake override', async () => {
  await withPanel(async ({ app, repository, sleepWakeState }) => {
    const configResponse = await patchSleep(app, { enabled: true, bedtime: '20:00', wake: '07:00', goodnight: true });
    assert.equal(configResponse.status, 200);
    repository.recordDecision({
      time: now - 30 * 60_000,
      sessionId: sessionId(groupSession),
      messageId: 'recent-reply',
      replied: true,
      reason: 'replied',
      detail: {},
    });
    repository.recordDecision({
      time: now - 61 * 60_000,
      sessionId: sessionId(groupSession),
      messageId: 'old-reply',
      replied: true,
      reason: 'replied',
      detail: {},
    });

    const awakeResponse = await app.request('/api/sleep', { headers: authHeaders() });
    const awake = await awakeResponse.json() as { status: string; energy: number | null; nextChangeAt: number | null };
    assert.equal(awake.status, 'awake');
    assert.ok(Math.abs((awake.energy ?? 0) - (1 - 0.8 * (5 / 13) - 0.01)) < 1e-9);
    assert.equal(awake.nextChangeAt, new Date(2026, 9, 13, 20).getTime());

    await patchSleep(app, { bedtime: '09:00', wake: '20:00' });
    const asleepResponse = await app.request('/api/sleep', { headers: authHeaders() });
    const asleep = await asleepResponse.json() as { status: string; energy: number | null; nextChangeAt: number | null };
    assert.equal(asleep.status, 'asleep');
    assert.equal(asleep.energy, null);
    assert.equal(asleep.nextChangeAt, new Date(2026, 9, 13, 20).getTime());

    sleepWakeState.activate(now);
    const wokenResponse = await app.request('/api/sleep', { headers: authHeaders() });
    const woken = await wokenResponse.json() as { status: string; energy: number | null; nextChangeAt: number | null };
    assert.equal(woken.status, 'woken');
    assert.equal(woken.energy, 1);
    assert.equal(woken.nextChangeAt, now + 30 * 60_000);
  });
});
