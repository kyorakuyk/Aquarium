import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../src/store/db.ts';
import { createRepository } from '../src/store/repository.ts';

test('repository 往返保存 Hill 状态锚点与事件游标', () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    repository.saveMoodState(Object.assign({
      account: 900000001,
      valence: 0.55,
      arousal: 0.75,
      dominance: -0.2,
      updatedAt: 1_000,
      band: 'excited' as const,
      bandSince: 900,
      lastBandChangeAt: 800,
      mainEmotion: null,
      emotionSince: null,
      lastEmotionChangeAt: null,
      reserve: 0.8,
      reserveBand: 'full' as const,
      reserveBandSince: null,
      reserveLastChangeAt: null,
      lastReplyAt: null,
    }, {
      valenceD0: 0.45,
      valenceU: 0.25,
      arousalD0: 0.35,
      arousalU: 0.5,
      dominanceD0: -0.2,
      dominanceU: 0.75,
    }));
    const state = repository.getMoodState(900000001) as unknown as Record<string, number | null>;
    assert.deepEqual({
      valenceD0: state.valenceD0,
      valenceU: state.valenceU,
      arousalD0: state.arousalD0,
      arousalU: state.arousalU,
      dominanceD0: state.dominanceD0,
      dominanceU: state.dominanceU,
    }, {
      valenceD0: 0.45,
      valenceU: 0.25,
      arousalD0: 0.35,
      arousalU: 0.5,
      dominanceD0: -0.2,
      dominanceU: 0.75,
    });

    repository.recordMoodEvent(Object.assign({
      account: 900000001,
      time: 2_000,
      source: 'appraise' as const,
      sessionId: '900000001:group:123456',
      senderId: 42,
      dv: 0.1,
      da: 0.2,
      dd: -0.1,
      appliedDv: 0.1,
      appliedDa: 0.2,
      appliedDd: -0.1,
      dominanceAfter: -0.3,
      causeTag: null,
      reason: 'test',
      bandBefore: 'calm' as const,
      bandAfter: 'aroused' as const,
      valenceAfter: 0.65,
      arousalAfter: 0.9,
      dr: 0,
      appliedDr: 0,
      absorbed: 0,
      reserveAfter: 0.8,
      appraisalValid: true,
    }, {
      valenceUAfter: 0.1,
      arousalUAfter: 0.2,
      dominanceUAfter: 0.3,
    }));
    const [event] = repository.recentMoodEvents(900000001, 1) as unknown as Array<Record<string, number | null>>;
    assert.deepEqual({
      valenceUAfter: event?.valenceUAfter,
      arousalUAfter: event?.arousalUAfter,
      dominanceUAfter: event?.dominanceUAfter,
    }, {
      valenceUAfter: 0.1,
      arousalUAfter: 0.2,
      dominanceUAfter: 0.3,
    });
    const [sinceEvent] = repository.moodEventsSince(900000001, 2_000) as unknown as Array<Record<string, number | null>>;
    const latestEvent = repository.latestMoodEventAtOrBefore(900000001, 2_000) as unknown as Record<string, number | null>;
    assert.equal(sinceEvent?.valenceUAfter, 0.1);
    assert.equal(sinceEvent?.arousalUAfter, 0.2);
    assert.equal(sinceEvent?.dominanceUAfter, 0.3);
    assert.equal(latestEvent.valenceUAfter, 0.1);
    assert.equal(latestEvent.arousalUAfter, 0.2);
    assert.equal(latestEvent.dominanceUAfter, 0.3);
  } finally {
    database.close();
  }
});
