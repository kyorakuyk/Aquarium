import assert from 'node:assert/strict';
import test from 'node:test';
import { holdDecay } from '../src/core/mood/core.ts';
import { resolveMoodSettings } from '../src/core/mood/settings.ts';
import { resolveMoodState } from '../src/core/mood/state.ts';
import { DEFAULT_PERSONA_MOOD } from '../src/persona/mood.ts';
import { sessionId } from '../src/core/shared/events.ts';
import { account, authHeaders, groupSession, now, withPanel } from './panel-test-helpers.ts';

test('mood API resolves companionship recovery over the stored-state interval', async () => {
  await withPanel(async ({ app, repository }) => {
    const start = now - 20 * 60_000;
    repository.saveMoodState({
      account,
      valence: 0.1,
      arousal: 0.4,
      dominance: 0,
      updatedAt: start,
      band: 'calm',
      bandSince: start - 30 * 60_000,
      lastBandChangeAt: start - 30 * 60_000,
      mainEmotion: '平静',
      emotionSince: start - 30 * 60_000,
      lastEmotionChangeAt: start - 30 * 60_000,
      reserve: 0.63,
      reserveBand: 'tired',
      reserveBandSince: start - 30 * 60_000,
      reserveLastChangeAt: start - 30 * 60_000,
      lastReplyAt: start,
    });
    repository.recordMoodEvent({
      account,
      time: start,
      source: 'appraise',
      sessionId: sessionId(groupSession),
      senderId: 42,
      dv: 0,
      da: 0,
      appliedDv: 0,
      appliedDa: 0,
      reason: 'neutral',
      bandBefore: null,
      bandAfter: null,
      valenceAfter: 0.1,
      arousalAfter: 0.4,
      dr: 0,
      appliedDr: 0,
      dd: 0,
      appliedDd: 0,
      dominanceAfter: 0,
      causeTag: '中性事件',
      absorbed: 0,
      reserveAfter: 0.63,
      appraisalValid: true,
    });
    repository.recordDecision({
      time: start,
      sessionId: sessionId(groupSession),
      messageId: 'stored-state-companion',
      replied: true,
      reason: 'replied',
      detail: {},
    });

    const response = await app.request('/api/mood', { headers: authHeaders() });
    assert.equal(response.status, 200);
    const body = await response.json() as { reserve: number; reserveBand: string };
    assert.equal(body.reserveBand, 'full');
    assert.ok(body.reserve > 0.65);
  }, undefined, { getEnergySource: () => 'outer' });
});

test('mood API does not apply a future appraisal to earlier recovery', async () => {
  await withPanel(async ({ app, repository }) => {
    const start = now - 12 * 60_000;
    const later = start + 10 * 60_000;
    repository.saveMoodState({
      account,
      valence: 0.1,
      arousal: 0.4,
      dominance: 0,
      updatedAt: start,
      band: 'calm',
      bandSince: start - 30 * 60_000,
      lastBandChangeAt: start - 30 * 60_000,
      mainEmotion: '平静',
      emotionSince: start - 30 * 60_000,
      lastEmotionChangeAt: start - 30 * 60_000,
      reserve: 0.63,
      reserveBand: 'tired',
      reserveBandSince: start - 30 * 60_000,
      reserveLastChangeAt: start - 30 * 60_000,
      lastReplyAt: start,
    });
    repository.recordDecision({
      time: start,
      sessionId: sessionId(groupSession),
      messageId: 'earlier-reply',
      replied: true,
      reason: 'replied',
      detail: {},
    });
    repository.recordDecision({
      time: later,
      sessionId: sessionId(groupSession),
      messageId: 'later-reply',
      replied: true,
      reason: 'replied',
      detail: {},
    });
    repository.recordMoodEvent({
      account,
      time: later,
      source: 'appraise',
      sessionId: sessionId(groupSession),
      senderId: 42,
      dv: 0,
      da: 0,
      appliedDv: 0,
      appliedDa: 0,
      reason: 'positive',
      bandBefore: null,
      bandAfter: null,
      valenceAfter: 0.1,
      arousalAfter: 0.4,
      dr: 0,
      appliedDr: 0,
      dd: 0,
      appliedDd: 0,
      dominanceAfter: 0,
      causeTag: '正向互动',
      absorbed: 0,
      reserveAfter: 0.63,
      appraisalValid: true,
    });

    const response = await app.request('/api/mood', { headers: authHeaders() });
    assert.equal(response.status, 200);
    const body = await response.json() as { reserveBand: string };
    assert.equal(body.reserveBand, 'tired');
  }, undefined, { getEnergySource: () => 'outer' });
});

test('mood API resolves decay with persona shapes but reports the global settings', async () => {
  const personaMood = {
    ...DEFAULT_PERSONA_MOOD,
    surfaceHoldShape: 5,
    arousalHoldShape: 4,
  };
  await withPanel(async ({ app, repository, getConfig }) => {
    const updatedAt = now - 30 * 60_000;
    repository.saveMoodState({
      account,
      valence: 0.1 + holdDecay(0.6, 0.25, 3),
      arousal: 0.4 + holdDecay(0.4, 0.25, 2),
      dominance: holdDecay(0.2, 0.25, 2),
      valenceD0: 0.6,
      valenceU: 0.25,
      arousalD0: 0.4,
      arousalU: 0.25,
      dominanceD0: 0.2,
      dominanceU: 0.25,
      updatedAt,
      band: 'calm',
      bandSince: updatedAt,
      lastBandChangeAt: updatedAt,
      mainEmotion: null,
      emotionSince: null,
      lastEmotionChangeAt: null,
      reserve: 0.6,
      reserveBand: 'tired',
      reserveBandSince: updatedAt,
      reserveLastChangeAt: updatedAt,
      lastReplyAt: null,
    });
    const response = await app.request('/api/mood', { headers: authHeaders() });
    assert.equal(response.status, 200);
    const body = await response.json() as {
      valence: number;
      arousal: number;
      dominance: number;
      settings: { surfaceHoldShape: number; arousalHoldShape: number };
    };
    const settings = resolveMoodSettings(getConfig().mood, personaMood);
    const expected = resolveMoodState({
      stored: repository.getMoodState(account),
      at: now,
      settings,
      energySource: 'mixed',
      appraisalEvents: [],
      replyTimes: [],
    });

    assert.ok(Math.abs(body.valence - expected.valence) < 1e-12);
    assert.ok(Math.abs(body.arousal - expected.arousal) < 1e-12);
    assert.ok(Math.abs(body.dominance - expected.dominance) < 1e-12);
    assert.equal(body.settings.surfaceHoldShape, getConfig().mood.surfaceHoldShape);
    assert.equal(body.settings.arousalHoldShape, getConfig().mood.arousalHoldShape);
  }, undefined, { getPersonaMoodSettings: () => personaMood });
});
