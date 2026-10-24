import assert from 'node:assert/strict';
import test from 'node:test';
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
