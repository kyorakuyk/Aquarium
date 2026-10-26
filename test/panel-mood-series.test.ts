import assert from 'node:assert/strict';
import test from 'node:test';
import { holdDecay, recoverReserve, surfaceHalfLifeMin } from '../src/core/mood/core.ts';
import { DEFAULT_PERSONA_MOOD } from '../src/persona/mood.ts';
import { sessionId } from '../src/core/shared/events.ts';
import type { MoodBand } from '../src/store/affect-repo.ts';
import { account, authHeaders, groupSession, now, withPanel } from './panel-test-helpers.ts';

const hourMs = 60 * 60_000;
const dayMs = 24 * hourMs;

function addMoodEvent(
  repository: Parameters<Parameters<typeof withPanel>[0]>[0]['repository'],
  input: {
    time: number;
    source: 'appraise' | 'rule' | 'band';
    reason: string;
    valenceAfter: number;
    arousalAfter: number;
    bandBefore?: MoodBand | null;
    bandAfter?: MoodBand | null;
    dominanceAfter?: number;
    causeTag?: string | null;
    reserveAfter?: number | null;
    absorbed?: number;
    appraisalValid?: boolean | null;
  },
): void {
  repository.recordMoodEvent({
    account,
    time: input.time,
    source: input.source,
    sessionId: sessionId(groupSession),
    senderId: 42,
    dv: 0,
    da: 0,
    appliedDv: 0,
    appliedDa: 0,
    reason: input.reason,
    bandBefore: input.bandBefore ?? null,
    bandAfter: input.bandAfter ?? null,
    valenceAfter: input.valenceAfter,
    arousalAfter: input.arousalAfter,
    dr: 0,
    appliedDr: 0,
    dd: 0,
    appliedDd: 0,
    dominanceAfter: input.dominanceAfter ?? 0,
    causeTag: input.causeTag ?? null,
    absorbed: input.absorbed ?? 0,
    reserveAfter: input.reserveAfter === undefined ? 0.8 : input.reserveAfter,
    appraisalValid: input.appraisalValid ?? (input.source === 'appraise'),
  });
}

test('mood series samples decay, five regions, and the latest reply injection trace', async () => {
  await withPanel(async ({ app, repository }) => {
    assert.equal((await app.request('/api/mood/series?hours=24')).status, 401);

    const from = now - dayMs;
    addMoodEvent(repository, {
      time: from,
      source: 'rule',
      reason: 'start',
      valenceAfter: 0.6,
      arousalAfter: 0.8,
    });
    addMoodEvent(repository, {
      time: now - 12 * hourMs,
      source: 'appraise',
      reason: 'middle',
      valenceAfter: -0.5,
      arousalAfter: 0.2,
      reserveAfter: 0.725,
      absorbed: 0.05,
    });
    addMoodEvent(repository, {
      time: now - hourMs,
      source: 'band',
      reason: 'event',
      valenceAfter: -0.4,
      arousalAfter: 0.5,
      bandBefore: 'excited',
      bandAfter: 'oppressed',
    });
    repository.saveMoodState({
      account,
      valence: -0.4,
      arousal: 0.5,
      dominance: 0,
      updatedAt: now,
      band: 'oppressed',
      bandSince: now - 2 * hourMs,
      lastBandChangeAt: now - 2 * hourMs,
      mainEmotion: '心疼',
      emotionSince: now - 2 * hourMs,
      lastEmotionChangeAt: now - 2 * hourMs,
      reserve: 0.8,
      reserveBand: 'full',
      reserveBandSince: null,
      reserveLastChangeAt: null,
      lastReplyAt: null,
    });
    repository.recordDecision({
      time: now - 10,
      sessionId: sessionId(groupSession),
      messageId: 'latest-reply',
      replied: true,
      reason: 'replied',
      detail: {
        injectedAffectBlocks: {
          mood: '当前心情：不太高兴。',
          reserve: '有点累，想一个人待会儿。',
          float: '此刻有些疲惫。',
          affinity: '对小明保持温和。token=K9m4R2p8T1v6',
        },
      },
    });
    repository.recordPipelineTrace({
      time: now - 9,
      sessionId: sessionId(groupSession),
      messageId: 'latest-reply',
      trace: [{
        step: 'context',
        detail: {
          injectedAffectBlocks: {
            mood: '当前心情：不太高兴。',
          reserve: '有点累，想一个人待会儿。',
            float: '此刻有些疲惫。',
            affinity: '对小明保持温和。token=K9m4R2p8T1v6',
          },
        },
      }],
    });
    repository.recordDecision({
      time: now - 5,
      sessionId: sessionId(groupSession),
      messageId: 'newer-skip',
      replied: false,
      reason: 'disabled',
      detail: { injectedAffectBlocks: { mood: '不应展示。' } },
    });

    const response = await app.request('/api/mood/series?hours=24', { headers: authHeaders() });
    assert.equal(response.status, 200);
    const body = await response.json() as {
      from: number;
      to: number;
      points: Array<{ time: number; valence: number; arousal: number; dominance: number; region: string; reserve: number; absorbed: number; event: boolean }>;
      current: {
        valence: number;
        arousal: number;
        dominance: number;
        reserve: number;
        reserveBand: string;
        energySource: string;
        band: string;
        bandSince: number | null;
        mainEmotion: string;
        subEmotions: string[];
      };
      bandChanges: Array<{ time: number; from: string; to: string }>;
      energy: { value: number | null; status: string; points: Array<{ time: number; value: number | null }> };
      latestReply: { id: number; blocks: { mood: string | null; reserve: string | null; float: string | null; affinity: string | null } } | null;
    };

    assert.equal(body.from, from);
    assert.equal(body.to, now);
    const gridTimes = new Set<number>([from, now]);
    for (let time = from + 15 * 60_000; time < now; time += 15 * 60_000) gridTimes.add(time);
    const expectedTimes = new Set(gridTimes);
    const curveEvents = [
      { time: from, reserve: 0.8 },
      { time: now - 12 * hourMs, reserve: 0.725 },
      { time: now - hourMs, reserve: 0.8 },
    ];
    for (const event of curveEvents) {
      const curves = [
        { halfLifeMin: surfaceHalfLifeMin(event.reserve, 40), shape: 4 },
        { halfLifeMin: 40, shape: 5 },
      ];
      for (const { halfLifeMin, shape } of curves) {
        const t50Ms = halfLifeMin * 60_000;
        const tau10Ms = t50Ms * (1 / 9) ** (1 / shape);
        for (const time of [event.time + Math.round(tau10Ms), event.time + Math.round(t50Ms)]) {
          if (time >= from && time <= now) expectedTimes.add(time);
        }
      }
    }
    const actualTimes = new Set(body.points.map((point) => point.time));
    assert.equal(gridTimes.size, 97);
    assert.ok([...gridTimes].every((time) => actualTimes.has(time)));
    assert.deepEqual(
      [...actualTimes].filter((time) => !expectedTimes.has(time)),
      [],
    );
    assert.deepEqual(
      [...expectedTimes].filter((time) => !actualTimes.has(time)),
      [],
    );
    assert.equal(actualTimes.size, body.points.length);
    assert.equal(body.points.length, expectedTimes.size);
    assert.equal(body.points[0]?.valence, 0.6);
    assert.equal(body.points[0]?.reserve, 0.8);
    assert.equal(body.points.find((point) => point.time === now - 12 * hourMs)?.valence, -0.5);
    assert.equal(body.points.find((point) => point.time === now - 12 * hourMs)?.reserve, 0.725);
    assert.equal(body.points.find((point) => point.time === now - 12 * hourMs)?.absorbed, 0.05);
    const interpolated = body.points.find((point) => point.time === now - 12 * hourMs + 15 * 60_000);
    const surfaceHalfLife = 40 * 1.4 / (0.4 + 0.725);
    const interpolatedValence = 0.1 + holdDecay(-0.6, 15 / surfaceHalfLife, 4);
    const interpolatedReserve = 0.725 - (interpolatedValence + 0.5) * 0.3;
    assert.ok(Math.abs((interpolated?.valence ?? 0) - interpolatedValence) < 1e-9);
    assert.ok(Math.abs((interpolated?.reserve ?? 0) - interpolatedReserve) < 1e-9);
    assert.equal(body.points.find((point) => point.time === now - hourMs)?.event, true);
    assert.equal(body.points.find((point) => point.time === now - hourMs)?.dominance, 0);
    assert.equal(body.points.find((point) => point.time === now - hourMs)?.region, 'oppressed');
    assert.deepEqual(body.bandChanges, [{ time: now - hourMs, from: 'excited', to: 'oppressed' }]);
    assert.equal(body.current.valence, -0.4);
    assert.equal(body.current.arousal, 0.5);
    assert.equal(body.current.dominance, 0);
    assert.equal(body.current.reserve, 0.8);
    assert.equal(body.current.reserveBand, 'full');
    assert.equal(body.current.energySource, 'mixed');
    assert.equal(body.current.band, 'oppressed');
    assert.equal(body.current.bandSince, now - 2 * hourMs);
    assert.equal(body.current.mainEmotion, '心疼');
    assert.ok(Array.isArray(body.current.subEmotions));
    assert.equal(body.energy.status, 'awake');
    assert.equal(body.energy.value, 1);
    assert.equal(body.energy.points.length, 7);
    assert.ok(body.energy.points.every((point) => point.value === 1));
    assert.equal(body.latestReply?.id, repository.latestReplyDecision()?.id);
    assert.deepEqual(body.latestReply?.blocks, {
      mood: '当前心情：不太高兴。',
          reserve: '有点累，想一个人待会儿。',
      float: '此刻有些疲惫。',
      affinity: '对小明保持温和。[敏感内容已隐藏]',
    });

    repository.saveMoodState({
      account,
      valence: 0.1,
      arousal: 0.5,
      dominance: 0,
      updatedAt: now,
      band: 'aroused',
      bandSince: now - 4 * 60_000,
      lastBandChangeAt: now - 4 * 60_000,
      mainEmotion: '平静',
      emotionSince: now - 4 * 60_000,
      lastEmotionChangeAt: now - 4 * 60_000,
      reserve: 0.8,
      reserveBand: 'full',
      reserveBandSince: null,
      reserveLastChangeAt: null,
      lastReplyAt: null,
    });
    const slidingResponse = await app.request('/api/mood/series?hours=24', { headers: authHeaders() });
    const slidingBody = await slidingResponse.json() as typeof body;
    assert.equal(slidingBody.current.band, 'aroused');
    assert.equal(slidingBody.current.bandSince, now - 4 * 60_000);
    assert.equal((await app.request('/api/mood/series?hours=0', { headers: authHeaders() })).status, 400);
  }, undefined, { getPersonaMoodSettings: () => ({
    ...DEFAULT_PERSONA_MOOD,
    surfaceHoldShape: 4,
    arousalHoldShape: 5,
  }) });
});

test('mood series carries reply and appraisal history from before an old anchor', async () => {
  await withPanel(async ({ app, repository }) => {
    const from = now - hourMs;
    const anchorTime = from - 20 * 60_000;
    const replyTime = anchorTime - 5 * 60_000;
    addMoodEvent(repository, {
      time: replyTime,
      source: 'appraise',
      reason: '相处愉快',
      valenceAfter: 0.1,
      arousalAfter: 0.4,
      reserveAfter: 0.2,
      appraisalValid: true,
    });
    addMoodEvent(repository, {
      time: anchorTime,
      source: 'rule',
      reason: 'anchor',
      valenceAfter: 0.1,
      arousalAfter: 0.4,
      reserveAfter: 0.2,
    });
    repository.recordDecision({
      time: replyTime,
      sessionId: sessionId(groupSession),
      messageId: 'pre-anchor-reply',
      replied: true,
      reason: 'replied',
      detail: {},
    });

    const response = await app.request('/api/mood/series?hours=1', { headers: authHeaders() });
    assert.equal(response.status, 200);
    const body = await response.json() as { points: Array<{ time: number; reserve: number }> };
    const first = body.points.find((point) => point.time === from);
    const afterCompany = recoverReserve({
      reserve: 0.2,
      energySource: 'outer',
      elapsedMs: 10 * 60_000,
      company: true,
      sad: false,
    });
    const expected = recoverReserve({
      reserve: afterCompany,
      energySource: 'outer',
      elapsedMs: 10 * 60_000,
      company: false,
      sad: false,
    });
    assert.ok(Math.abs((first?.reserve ?? 0) - expected) < 1e-9);
  }, undefined, { getEnergySource: () => 'outer' });
});
