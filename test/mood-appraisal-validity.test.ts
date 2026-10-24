import assert from 'node:assert/strict';
import test from 'node:test';
import { withRepository } from './pipeline-test-helpers.ts';

test('mood events persist explicit appraisal validity independently of free-text reason', async () => {
  await withRepository(async (repository) => {
    const base = {
      account: 900000001,
      time: 1000,
      source: 'appraise' as const,
      sessionId: '900000001:group:123456',
      senderId: 42,
      dv: 0,
      da: 0,
      appliedDv: 0,
      appliedDa: 0,
      bandBefore: null,
      bandAfter: null,
      valenceAfter: 0.1,
      arousalAfter: 0.4,
      dr: 0,
      appliedDr: 0,
      dd: 0,
      appliedDd: 0,
      dominanceAfter: 0,
      absorbed: 0,
      reserveAfter: 0.8,
    };
    const record = (reason: string, appraisalValid: boolean, time: number) => repository.recordMoodEvent({
      ...base,
      time,
      reason,
      causeTag: appraisalValid ? '中性事件' : null,
      appraisalValid,
    });

    record('budget', true, 1000);
    record('appraise_error', false, 2000);

    const events = repository.recentMoodEvents(900000001, 2);
    assert.deepEqual(events.map((event) => [event.reason, event.appraisalValid]), [
      ['appraise_error', false],
      ['budget', true],
    ]);
    assert.deepEqual(events.map((event) => event.causeTag), [null, '中性事件']);
  });
});
