import assert from 'node:assert/strict';
import test from 'node:test';
import type { IncomingMessage } from '../src/core/shared/events.ts';
import { sessionId } from '../src/core/shared/events.ts';
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

test('未启用群可以拉取并整理历史，但仍保持未启用', async () => {
  await withPanel(async ({ app, adapter, historyImports, repository }) => {
    const id = sessionId(groupSession);
    const initialView = await app.request(`/api/impressions/${id}`, { headers: authHeaders() });
    assert.equal((await initialView.json() as { lastMessageTime: number | null }).lastMessageTime, null);
    const disabled = await app.request(`/api/sessions/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: jsonHeaders(),
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(disabled.status, 200);
    adapter.status = 'online';
    adapter.historyPages.push([message('disabled-1', 1_000), message('disabled-2', 2_000)]);

    const started = await app.request(`/api/impressions/${id}/import`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ target: 200 }),
    });
    assert.equal(started.status, 202);
    const { id: jobId } = await started.json() as { id: string };
    await historyImports.idle();

    const previewResponse = await app.request(`/api/impressions/import/${jobId}`, { headers: authHeaders() });
    const preview = await previewResponse.json() as { phase: string; mode: string; newMessages: number; estimatedCostCny?: number };
    assert.equal(previewResponse.status, 200);
    assert.equal(preview.phase, 'awaiting_confirmation');
    assert.equal(preview.mode, 'incremental');
    assert.equal(preview.newMessages, 2);
    assert.equal(preview.estimatedCostCny, undefined);
    assert.equal(repository.getTagRun(account, id), undefined);

    const confirm = await app.request(`/api/impressions/import/${jobId}/confirm`, {
      method: 'POST',
      headers: authHeaders(),
    });
    assert.equal(confirm.status, 202);
    assert.equal((await confirm.json() as { phase: string }).phase, 'extracting');
    await historyImports.idle();

    const response = await app.request(`/api/impressions/import/${jobId}`, { headers: authHeaders() });
    const job = await response.json() as { phase: string; fetched: number; inserted: number };
    assert.equal(response.status, 200);
    assert.equal(job.phase, 'done');
    assert.equal(job.fetched, 2);
    assert.equal(job.inserted, 2);
    assert.equal(repository.getTagRun(account, id)?.lastMessageTime, 2_000);
    const completedView = await app.request(`/api/impressions/${id}`, { headers: authHeaders() });
    assert.equal((await completedView.json() as { lastMessageTime: number | null }).lastMessageTime, 2_000);

    const sessionsResponse = await app.request('/api/sessions', { headers: authHeaders() });
    const sessions = await sessionsResponse.json() as Array<{ sessionId: string; enabled: boolean }>;
    assert.equal(sessions.find((session) => session.sessionId === id)?.enabled, false);
  });
});
