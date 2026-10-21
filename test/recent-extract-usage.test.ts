import assert from 'node:assert/strict';
import test from 'node:test';
import { groupSession, withRepository } from './pipeline-test-helpers.ts';

test('recentExtractAverageCost averages only the latest 30 extract calls', async () => {
  await withRepository(async (repository) => {
    for (let index = 0; index < 31; index += 1) {
      repository.recordUsage({
        time: index + 1,
        account: groupSession.account,
        slot: 'extract',
        provider: 'fixture',
        model: 'fixture-model',
        inputTokens: 1,
        cachedTokens: 0,
        outputTokens: 1,
        costCny: index,
        latencyMs: 1,
        ok: true,
      });
    }
    repository.recordUsage({
      time: 32,
      account: groupSession.account,
      slot: 'reply',
      provider: 'fixture',
      model: 'fixture-model',
      inputTokens: 1,
      cachedTokens: 0,
      outputTokens: 1,
      costCny: 1_000,
      latencyMs: 1,
      ok: true,
    });

    assert.equal(repository.recentExtractAverageCost(), 15.5);
  });
});

test('recentExtractAverageCost is unavailable when there is no extract history', async () => {
  await withRepository(async (repository) => {
    assert.equal(repository.recentExtractAverageCost(), undefined);
  });
});
