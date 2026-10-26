import assert from 'node:assert/strict';
import test from 'node:test';
import { createMoodService } from '../src/core/mood/service.ts';
import { holdDecay } from '../src/core/mood/core.ts';
import { promptTemplateStore } from '../src/core/prompt/templates.ts';
import { sessionId } from '../src/core/shared/events.ts';
import { openDatabase } from '../src/store/db.ts';
import { createRepository } from '../src/store/repository.ts';
import { groupSession, makeConfig } from './pipeline-test-helpers.ts';

function initialState(account: number, now: number) {
  return {
    account,
    valence: 0.1 + holdDecay(-0.4, 0.5, 3),
    arousal: 0.4 + holdDecay(0.3, 0.5, 2),
    dominance: holdDecay(0.2, 0.5, 2),
    valenceD0: -0.4,
    valenceU: 0.5,
    arousalD0: 0.3,
    arousalU: 0.5,
    dominanceD0: 0.2,
    dominanceU: 0.5,
    updatedAt: now,
    band: 'calm' as const,
    bandSince: now,
    lastBandChangeAt: now,
    mainEmotion: null,
    emotionSince: null,
    lastEmotionChangeAt: null,
    reserve: 0.8,
    reserveBand: 'full' as const,
    reserveBandSince: now,
    reserveLastChangeAt: now,
    lastReplyAt: null,
  };
}

test('recordCalled reanchors arousal and records all post-event cursors', () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    const config = makeConfig();
    const account = groupSession.account;
    const session = sessionId(groupSession);
    const now = 1_000_000;
    const initial = initialState(account, now);
    repository.saveMoodState(initial);
    const mood = createMoodService({ repository, getConfig: () => config, now: () => now });

    mood.recordCalled({ account, sessionId: session, now });

    const state = repository.getMoodState(account);
    const event = repository.recentMoodEvents(account, 1)[0];
    const nextArousal = initial.arousal + (1 - initial.arousal) * 0.05;
    assert.equal(state?.arousal, nextArousal);
    assert.equal(state?.arousalD0, nextArousal - config.mood.baseline.arousal);
    assert.equal(state?.arousalU, 0);
    assert.equal(state?.valenceU, initial.valenceU);
    assert.equal(state?.dominanceU, initial.dominanceU);
    assert.equal(event?.reason, 'called');
    assert.equal(event?.valenceUAfter, initial.valenceU);
    assert.equal(event?.arousalUAfter, 0);
    assert.equal(event?.dominanceUAfter, initial.dominanceU);
  } finally {
    database.close();
  }
});

test('successful appraisal reanchors all dimensions and persists event cursors', async () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    const config = makeConfig();
    const account = groupSession.account;
    const session = sessionId(groupSession);
    const now = 1_000_000;
    const initial = initialState(account, now);
    repository.saveMoodState(initial);
    const mood = createMoodService({
      repository,
      getConfig: () => config,
      now: () => now,
      callModel: async () => ({
        text: '{"valence":0.1,"reserve":0,"arousal":-0.1,"dominance":-0.1,"causeTag":"安慰","reason":"安慰"}',
        provider: 'fake',
        model: 'fake-model',
        usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
      }),
    });

    await mood.afterReply({
      account,
      sessionId: session,
      senderId: 42,
      messageId: 'mood-hold-appraise',
      now,
      template: promptTemplateStore.get().appraise,
      energySource: 'mixed',
    });
    await mood.idle();

    const state = repository.getMoodState(account);
    const event = repository.recentMoodEvents(account, 10).find((item) => item.reason === '安慰');
    assert.ok(state);
    const valenceDelta = state.valence - config.mood.baseline.valence;
    const arousalDelta = state.arousal - config.mood.baseline.arousal;
    const expectedValenceD0 = valenceDelta * (1 + initial.valenceU ** 3);
    const expectedArousalD0 = arousalDelta * (1 + initial.arousalU ** 2);
    const expectedDominanceD0 = state.dominance * (1 + initial.dominanceU ** 2);
    assert.equal(state.valenceU, initial.valenceU);
    assert.equal(state.arousalU, initial.arousalU);
    assert.equal(state.dominanceU, initial.dominanceU);
    assert.ok(Math.abs(state.valenceD0 - expectedValenceD0) < 1e-12,
      `valenceD0 actual=${state.valenceD0}, expected=${expectedValenceD0}`);
    assert.ok(Math.abs(state.arousalD0 - expectedArousalD0) < 1e-12,
      `arousalD0 actual=${state.arousalD0}, expected=${expectedArousalD0}`);
    assert.ok(Math.abs(state.dominanceD0 - expectedDominanceD0) < 1e-12,
      `dominanceD0 actual=${state.dominanceD0}, expected=${expectedDominanceD0}`);
    assert.equal(event?.valenceUAfter, initial.valenceU);
    assert.equal(event?.arousalUAfter, initial.arousalU);
    assert.equal(event?.dominanceUAfter, initial.dominanceU);
  } finally {
    database.close();
  }
});
