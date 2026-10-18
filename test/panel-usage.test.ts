import assert from 'node:assert/strict';
import test from 'node:test';
import { usageAccountLabels, usageCostLabel } from '../panel/src/usage-view.ts';
import { account, authHeaders, now, withPanel } from './panel-test-helpers.ts';

function localDayStart(time: number, offsetDays = 0): number {
  const date = new Date(time);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + offsetDays).getTime();
}

test('usage API groups by provider/account, honors local ranges, and keeps seven daily points', async () => {
  await withPanel(async ({ app, repository }) => {
    const today = localDayStart(now);
    const tomorrow = localDayStart(now, 1);
    const start7d = localDayStart(now, -6);
    const start30d = localDayStart(now, -29);
    const record = (time: number, provider: string, usageAccount: number | null, slot: string, input: number, cached: number, cost: number) => {
      repository.recordUsage({
        time, account: usageAccount, slot, provider, model: 'test-model',
        inputTokens: input, cachedTokens: cached, outputTokens: 2, costCny: cost, latencyMs: 100, ok: true,
      });
    };

    record(start30d, 'deepseek', account, 'reply', 20, 10, 0.1);
    record(start7d, 'deepseek', account, 'judge', 20, 10, 0.2);
    record(today, 'deepseek', account, 'vision', 0, 0, 0);
    record(tomorrow - 1, 'deepseek', account, 'reply', 10, 0, 0.3);
    record(tomorrow, 'deepseek', account, 'reply', 10, 0, 1);
    record(today, 'deepseek', account + 1, 'reply', 30, 15, 0.4);
    record(today, 'cli', null, 'reply', 0, 0, 0);

    const headers = authHeaders();
    const [todayResponse, weekResponse, monthResponse] = await Promise.all([
      app.request('/api/usage?range=today', { headers }),
      app.request('/api/usage?range=7d', { headers }),
      app.request('/api/usage?range=30d', { headers }),
    ]);
    assert.equal(todayResponse.status, 200);
    assert.equal(weekResponse.status, 200);
    assert.equal(monthResponse.status, 200);
    const todayReport = await todayResponse.json() as { totals: { calls: number } };
    const weekReport = await weekResponse.json() as {
      totals: { calls: number; cacheHitRatio: number | null; budgetToday: { used: number } };
      rows: Array<{ provider: string; account: number | null; calls: number; cacheHitRatio: number | null; daily: number[]; bySlot: Array<{ slot: string }> }>;
    };
    const monthReport = await monthResponse.json() as { totals: { calls: number } };

    assert.equal(todayReport.totals.calls, 4);
    assert.equal(weekReport.totals.calls, 5);
    assert.equal(monthReport.totals.calls, 6);
    assert.equal(weekReport.rows.length, 3);
    const known = weekReport.rows.find((row) => row.provider === 'deepseek' && row.account === account);
    const other = weekReport.rows.find((row) => row.provider === 'deepseek' && row.account === account + 1);
    const legacy = weekReport.rows.find((row) => row.provider === 'cli' && row.account === null);
    assert.equal(known?.calls, 3);
    assert.equal(known?.daily.length, 7);
    assert.deepEqual(known?.daily, [1, 0, 0, 0, 0, 0, 2]);
    assert.deepEqual(known?.bySlot.map((slot) => slot.slot), ['judge', 'reply', 'vision']);
    assert.equal(other?.calls, 1);
    assert.equal(legacy?.cacheHitRatio, null);
    assert.deepEqual(usageAccountLabels(legacy?.account ?? null, []), {
      primary: '未知',
      secondary: '旧记录未关联账号',
    });
    assert.equal(usageCostLabel('cli', 0), '—');
    assert.equal(weekReport.totals.cacheHitRatio, 25 / 60);
    assert.equal(weekReport.totals.budgetToday.used, 0.7);
  });
});
