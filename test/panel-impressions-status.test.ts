import assert from 'node:assert/strict';
import test from 'node:test';
import { watchImpressionsRunState } from '../panel/src/impressions-events.ts';
import { sessionId } from '../src/core/shared/events.ts';
import { authHeaders, groupSession, withPanel } from './panel-test-helpers.ts';

function eventText(chunk: Uint8Array | undefined): string {
  assert.ok(chunk);
  return new TextDecoder().decode(chunk);
}

test('印象提取任务状态流推送当前群的启动与完成', async () => {
  await withPanel(async ({ app, impressionsService }) => {
    const id = sessionId(groupSession);
    const base = `/api/impressions/${encodeURIComponent(id)}`;
    const statusUrl = `${base}/extraction-status`;
    const unauthorized = await app.request(statusUrl);
    assert.equal(unauthorized.status, 401);
    const idle = await app.request(statusUrl, { headers: authHeaders() });
    assert.equal(idle.status, 200);
    assert.deepEqual(await idle.json(), { running: false, completedAt: null });

    const response = await app.request(`${base}/events`, { headers: authHeaders() });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/u);
    const reader = response.body?.getReader();
    assert.ok(reader);
    assert.equal(eventText((await reader.read()).value), 'data: {"running":false,"completedAt":null}\n\n');

    const release = impressionsService.tryAcquireSession(id);
    assert.ok(release);
    assert.equal(eventText((await reader.read()).value), 'data: {"running":true,"completedAt":null}\n\n');
    const active = await app.request(statusUrl, { headers: authHeaders() });
    assert.deepEqual(await active.json(), { running: true, completedAt: null });

    release();
    const completedEvent = eventText((await reader.read()).value);
    assert.match(completedEvent, /^data: \{"running":false,"completedAt":\d+\}\n\n$/u);
    const done = await app.request(statusUrl, { headers: authHeaders() });
    const doneStatus = await done.json() as { running: boolean; completedAt: number | null };
    assert.equal(doneStatus.running, false);
    assert.equal(typeof doneStatus.completedAt, 'number');
    await reader.cancel();
  });
});

test('面板监听器分块读取印象提取任务状态事件', async () => {
  const controller = new AbortController();
  const states: boolean[] = [];
  const encoder = new TextEncoder();
  let requests = 0;
  const fetcher: typeof fetch = async () => {
    requests += 1;
    if (requests > 1) controller.abort();
    return new Response(new ReadableStream<Uint8Array>({
      start(stream) {
        if (requests === 1) {
          stream.enqueue(encoder.encode('data: {"running":false,"completedAt":'));
          stream.enqueue(encoder.encode('null}\n\ndata: {"running":true,"completedAt":null}\n\n'));
          stream.enqueue(encoder.encode('data: {"running":false,"completedAt":1700000000000}\n\n'));
        }
        stream.close();
      },
    }));
  };

  await watchImpressionsRunState(sessionId(groupSession), controller.signal, (status) => {
    states.push(status.running);
  }, { fetcher, password: null, retryDelayMs: 0 });

  assert.deepEqual(states, [false, true, false]);
});

test('状态流遇到不可重试的 404 后停止重连', async () => {
  const controller = new AbortController();
  let requests = 0;
  const fetcher: typeof fetch = async () => {
    requests += 1;
    if (requests > 1) controller.abort();
    return new Response('{"error":"not found"}', { status: 404 });
  };

  await watchImpressionsRunState(sessionId(groupSession), controller.signal, () => {}, {
    fetcher,
    password: null,
    retryDelayMs: 0,
  });

  assert.equal(requests, 1);
});
