import assert from 'node:assert/strict';
import test from 'node:test';
import type { IncomingMessage } from '../src/core/events.ts';
import { sessionId } from '../src/core/events.ts';
import { account, authHeaders, groupSession, withPanel } from './panel-test-helpers.ts';

function jsonHeaders(): HeadersInit {
  return { ...authHeaders(), 'Content-Type': 'application/json' };
}

function message(messageId: string, time: number): IncomingMessage {
  return {
    session: groupSession,
    messageId,
    senderId: 42,
    senderName: '群友',
    segments: [{ type: 'text', text: messageId }],
    plainText: messageId,
    mentionsSelf: false,
    replyToSelf: false,
    time,
  };
}

test('history import API rejects offline accounts and duplicate jobs, then cancels after the in-flight page', async () => {
  await withPanel(async ({ app, repository, adapter, historyImports }) => {
    const endpoint = `/api/impressions/${sessionId(groupSession)}/import`;
    const request = () => app.request(endpoint, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ target: 200 }),
    });

    adapter.status = 'offline';
    const offline = await request();
    assert.equal(offline.status, 503);
    assert.equal((await offline.json() as { error: string }).error, '小号不在线');

    let resolvePage!: (messages: IncomingMessage[]) => void;
    adapter.historyGate = new Promise((resolve) => { resolvePage = resolve; });
    adapter.status = 'online';
    const started = await request();
    assert.equal(started.status, 202);
    const { id } = await started.json() as { id: string };

    const duplicate = await request();
    assert.equal(duplicate.status, 409);
    const cancel = await app.request(`/api/impressions/import/${id}/cancel`, {
      method: 'POST',
      headers: authHeaders(),
    });
    assert.equal(cancel.status, 200);
    assert.equal((await cancel.json() as { cancelRequested: boolean }).cancelRequested, true);

    resolvePage([message('cancel-1', 1000), message('cancel-2', 2000)]);
    await historyImports.idle();

    const status = await app.request(`/api/impressions/import/${id}`, { headers: authHeaders() });
    const job = await status.json() as { phase: string; fetched: number; inserted: number };
    assert.equal(status.status, 200);
    assert.equal(job.phase, 'cancelled');
    assert.equal(job.fetched, 2);
    assert.equal(job.inserted, 2);
    assert.equal(repository.getTagRun(account, sessionId(groupSession)), undefined);
    assert.deepEqual(repository.recentDecisions(10), []);
    assert.deepEqual(repository.recentMoodEvents(account, 10), []);
    assert.deepEqual(repository.recentAffinityEvents(account, 42, 10), []);
  });
});
