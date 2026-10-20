import assert from 'node:assert/strict';
import test from 'node:test';
import { withPanel, authHeaders } from './panel-test-helpers.ts';
import type { TagClassificationService, TagClassificationStatus } from '../src/core/impressions/classify-tags.ts';

function fakeService(): TagClassificationService {
  let state: TagClassificationStatus['state'] = 'idle';
  return {
    startOnStartup() {},
    startManual() {
      if (state === 'running') return false;
      state = 'running';
      return true;
    },
    status() {
      return {
        state,
        total: 3,
        processed: 0,
        merged: 0,
        lockedSkipped: 1,
        remaining: 3,
        startedAt: null,
        completedAt: null,
      };
    },
    async idle() {},
  };
}

test('画像旧标签整理 API 受面板认证保护并可触发后台任务', async () => {
  const service = fakeService();
  await withPanel(async ({ app }) => {
    const unauthorized = await app.request('/api/tags/classify');
    assert.equal(unauthorized.status, 401);

    const started = await app.request('/api/tags/classify', {
      method: 'POST',
      headers: authHeaders(),
    });
    assert.equal(started.status, 202);
    assert.equal((await started.json() as { state: string }).state, 'running');

    const duplicate = await app.request('/api/tags/classify', {
      method: 'POST',
      headers: authHeaders(),
    });
    assert.equal(duplicate.status, 409);

    const status = await app.request('/api/tags/classify', { headers: authHeaders() });
    assert.equal(status.status, 200);
    assert.equal((await status.json() as { lockedSkipped: number }).lockedSkipped, 1);
  }, undefined, { tagClassificationService: service });
});
