import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionId } from '../src/core/shared/events.ts';
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
    bandBefore?: 'low' | 'annoyed' | 'calm' | 'happy' | 'excited' | null;
    bandAfter?: 'low' | 'annoyed' | 'calm' | 'happy' | 'excited' | null;
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
  });
}

test('mood series samples decay, friction distance and the latest reply injection trace', async () => {
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
    });
    addMoodEvent(repository, {
      time: now - hourMs,
      source: 'band',
      reason: 'event',
      valenceAfter: -0.4,
      arousalAfter: 0.5,
      bandBefore: 'happy',
      bandAfter: 'annoyed',
    });
    repository.saveMoodState({
      account,
      valence: -0.4,
      arousal: 0.5,
      updatedAt: now,
      band: 'annoyed',
      bandSince: now - 2 * hourMs,
      lastBandChangeAt: now - 2 * hourMs,
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
      points: Array<{ time: number; valence: number; arousal: number; event: boolean }>;
      current: {
        valence: number;
        arousal: number;
        band: string;
        bandSince: number | null;
        distanceToNextBand: { amount: number; direction: string; targetBand: string; margin: number; friction: string };
      };
      bandChanges: Array<{ time: number; from: string; to: string }>;
      energy: { value: number | null; status: string; points: Array<{ time: number; value: number | null }> };
      latestReply: { id: number; blocks: { mood: string | null; float: string | null; affinity: string | null } } | null;
    };

    assert.equal(body.from, from);
    assert.equal(body.to, now);
    assert.equal(body.points.length, 97);
    assert.equal(body.points[0]?.valence, 0.6);
    assert.equal(body.points.find((point) => point.time === now - 12 * hourMs)?.valence, -0.5);
    const interpolated = body.points.find((point) => point.time === now - 12 * hourMs + 15 * 60_000);
    assert.ok(Math.abs((interpolated?.valence ?? 0) - (0.1 + (-0.5 - 0.1) * 2 ** (-15 / 30))) < 1e-9);
    assert.equal(body.points.find((point) => point.time === now - hourMs)?.event, true);
    assert.deepEqual(body.bandChanges, [{ time: now - hourMs, from: 'happy', to: 'annoyed' }]);
    assert.equal(body.current.valence, -0.4);
    assert.equal(body.current.arousal, 0.5);
    assert.equal(body.current.band, 'annoyed');
    assert.equal(body.current.bandSince, now - 2 * hourMs);
    assert.ok(Math.abs(body.current.distanceToNextBand.amount - 0.18) < 1e-9);
    assert.equal(body.current.distanceToNextBand.direction, 'down');
    assert.equal(body.current.distanceToNextBand.targetBand, 'low');
    assert.equal(body.current.distanceToNextBand.margin, 0.08);
    assert.equal(body.current.distanceToNextBand.friction, 'static');
    assert.equal(body.energy.status, 'awake');
    assert.equal(body.energy.value, 1);
    assert.equal(body.energy.points.length, 7);
    assert.ok(body.energy.points.every((point) => point.value === 1));
    assert.equal(body.latestReply?.id, repository.latestReplyDecision()?.id);
    assert.deepEqual(body.latestReply?.blocks, {
      mood: '当前心情：不太高兴。',
      float: '此刻有些疲惫。',
      affinity: '对小明保持温和。[敏感内容已隐藏]',
    });

    repository.saveMoodState({
      account,
      valence: 0.1,
      arousal: 0.5,
      updatedAt: now,
      band: 'calm',
      bandSince: now - 4 * 60_000,
      lastBandChangeAt: now - 4 * 60_000,
    });
    const slidingResponse = await app.request('/api/mood/series?hours=24', { headers: authHeaders() });
    const slidingBody = await slidingResponse.json() as typeof body;
    assert.equal(slidingBody.current.distanceToNextBand.friction, 'sliding');
    assert.equal(slidingBody.current.distanceToNextBand.margin, 0.02);
    assert.equal(slidingBody.current.distanceToNextBand.direction, 'up');
    assert.ok(Math.abs(slidingBody.current.distanceToNextBand.amount - 0.07) < 1e-9);
    assert.equal((await app.request('/api/mood/series?hours=0', { headers: authHeaders() })).status, 400);
  });
});
