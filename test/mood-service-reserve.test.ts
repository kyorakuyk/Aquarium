import assert from 'node:assert/strict';
import test from 'node:test';
import { createMoodService } from '../src/core/mood/service.ts';
import { recoverReserve } from '../src/core/mood/core.ts';
import { promptTemplateStore } from '../src/core/prompt/templates.ts';
import { sessionId } from '../src/core/shared/events.ts';
import { groupSession, makeConfig, withRepository } from './pipeline-test-helpers.ts';

test('a later positive appraisal is not retroactively applied to earlier recovery', async () => {
  await withRepository(async (repository) => {
    const config = makeConfig();
    const start = new Date(2026, 9, 12, 9, 0).getTime();
    const account = groupSession.account;
    repository.saveMoodState({
      account,
      valence: config.mood.baseline.valence,
      arousal: config.mood.baseline.arousal,
      updatedAt: start,
      band: 'calm',
      bandSince: start - 30 * 60_000,
      lastBandChangeAt: start - 30 * 60_000,
      reserve: 0.63,
      reserveBand: 'tired',
      reserveBandSince: start - 30 * 60_000,
      reserveLastChangeAt: start - 30 * 60_000,
      lastReplyAt: start,
    });
    repository.recordDecision({
      time: start,
      sessionId: sessionId(groupSession),
      messageId: 'initial-reply',
      replied: true,
      reason: 'replied',
      detail: {},
    });
    const nextReply = start + 10 * 60_000;
    repository.recordDecision({
      time: nextReply,
      sessionId: sessionId(groupSession),
      messageId: 'later-reply',
      replied: true,
      reason: 'replied',
      detail: {},
    });
    repository.recordMoodEvent({
      account,
      time: nextReply,
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
      valenceAfter: config.mood.baseline.valence,
      arousalAfter: config.mood.baseline.arousal,
      dr: 0,
      appliedDr: 0,
      absorbed: 0,
      reserveAfter: 0.63,
      appraisalValid: true,
    });
    const mood = createMoodService({ repository, getConfig: () => config, now: () => start });

    const blocks = mood.promptBlocks({
      account,
      now: start + 12 * 60_000,
      template: promptTemplateStore.get().affect,
      energySource: 'outer',
      record: false,
    });
    const alone = recoverReserve({ reserve: 0.63, energySource: 'outer', elapsedMs: 10 * 60_000, company: false, sad: false });
    const expected = recoverReserve({ reserve: alone, energySource: 'outer', elapsedMs: 2 * 60_000, company: true, sad: false });

    assert.ok(expected < 0.65);
    assert.equal(blocks.reserve, '有点累，想有人陪着说说话');
  });
});

test('successful appraisal text equal to a failure label still counts for companionship', async () => {
  await withRepository(async (repository) => {
    const config = makeConfig();
    const start = new Date(2026, 9, 12, 9, 0).getTime();
    const account = groupSession.account;
    repository.saveMoodState({
      account,
      valence: config.mood.baseline.valence,
      arousal: config.mood.baseline.arousal,
      updatedAt: start,
      band: 'calm',
      bandSince: start - 30 * 60_000,
      lastBandChangeAt: start - 30 * 60_000,
      reserve: 0.63,
      reserveBand: 'tired',
      reserveBandSince: start - 30 * 60_000,
      reserveLastChangeAt: start - 30 * 60_000,
      lastReplyAt: start,
    });
    repository.recordMoodEvent({
      account,
      time: start + 1_000,
      source: 'appraise',
      sessionId: sessionId(groupSession),
      senderId: 42,
      dv: 0,
      da: 0,
      appliedDv: 0,
      appliedDa: 0,
      reason: 'budget',
      bandBefore: null,
      bandAfter: null,
      valenceAfter: config.mood.baseline.valence,
      arousalAfter: config.mood.baseline.arousal,
      dr: 0,
      appliedDr: 0,
      absorbed: 0,
      reserveAfter: 0.63,
      appraisalValid: true,
    } as Parameters<typeof repository.recordMoodEvent>[0] & { appraisalValid: true });
    const mood = createMoodService({ repository, getConfig: () => config, now: () => start });

    const blocks = mood.promptBlocks({
      account,
      now: start + 14 * 60_000,
      template: promptTemplateStore.get().affect,
      energySource: 'outer',
      record: false,
    });

    assert.equal(blocks.reserve, undefined);
  });
});

test('budget skipped appraisal cannot falsely recharge an outer persona', async () => {
  await withRepository(async (repository) => {
    const config = makeConfig();
    const start = new Date(2026, 9, 12, 9, 0).getTime();
    const account = groupSession.account;
    repository.saveMoodState({
      account,
      valence: config.mood.baseline.valence,
      arousal: config.mood.baseline.arousal,
      updatedAt: start,
      band: 'calm',
      bandSince: start - 30 * 60_000,
      lastBandChangeAt: start - 30 * 60_000,
      reserve: 0.63,
      reserveBand: 'tired',
      reserveBandSince: start - 30 * 60_000,
      reserveLastChangeAt: start - 30 * 60_000,
      lastReplyAt: start,
    });
    repository.recordMoodEvent({
      account,
      time: start + 1_000,
      source: 'appraise',
      sessionId: sessionId(groupSession),
      senderId: 42,
      dv: 0,
      da: 0,
      appliedDv: 0,
      appliedDa: 0,
      reason: 'budget',
      bandBefore: null,
      bandAfter: null,
      valenceAfter: config.mood.baseline.valence,
      arousalAfter: config.mood.baseline.arousal,
      dr: 0,
      appliedDr: 0,
      absorbed: 0,
      reserveAfter: 0.63,
      appraisalValid: false,
    });
    const mood = createMoodService({ repository, getConfig: () => config, now: () => start });

    const blocks = mood.promptBlocks({
      account,
      now: start + 14 * 60_000,
      template: promptTemplateStore.get().affect,
      energySource: 'outer',
      record: false,
    });

    assert.equal(blocks.reserve, '有点累，想有人陪着说说话');
  });
});

test('delayed outer state resolution keeps companionship only through its 15-minute window', async () => {
  await withRepository(async (repository) => {
    const config = makeConfig();
    const start = new Date(2026, 9, 12, 9, 0).getTime();
    const account = groupSession.account;
    repository.saveMoodState({
      account,
      valence: config.mood.baseline.valence,
      arousal: config.mood.baseline.arousal,
      updatedAt: start,
      band: 'calm',
      bandSince: start - 30 * 60_000,
      lastBandChangeAt: start - 30 * 60_000,
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
      valenceAfter: config.mood.baseline.valence,
      arousalAfter: config.mood.baseline.arousal,
      dr: 0,
      appliedDr: 0,
      absorbed: 0,
      reserveAfter: 0.63,
      appraisalValid: true,
    });
    repository.recordDecision({
      time: start,
      sessionId: sessionId(groupSession),
      messageId: 'last-companion-reply',
      replied: true,
      reason: 'replied',
      detail: {},
    });
    const mood = createMoodService({ repository, getConfig: () => config, now: () => start });

    const blocks = mood.promptBlocks({
      account,
      now: start + 20 * 60_000,
      template: promptTemplateStore.get().affect,
      energySource: 'outer',
      record: false,
    });

    assert.equal(blocks.reserve, undefined);
  });
});
