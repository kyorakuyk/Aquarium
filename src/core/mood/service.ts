import type { AquariumConfig } from '../../config/schema.ts';
import { budgetState } from '../../llm/budget.ts';
import { callSlot } from '../../llm/slots.ts';
import type { MoodBand, MoodEventRecord } from '../../store/affect-repo.ts';
import type { StoreRepository } from '../../store/repository.ts';
import type { AffinityService } from '../affinity/service.ts';
import type { AffectPromptTemplate, AppraisePromptTemplate } from '../prompt/templates.ts';
import type { PipelineModelCall } from '../conversation/steps/types.ts';
import { runAppraise } from './appraise.ts';
import { renderFloatBlock, renderMoodBlocks, type MoodPromptBlocks } from './render.ts';
import {
  bandOf,
  applyArousalDelta,
  bufferNegativeDelta,
  capSenderReserveDelta,
  capSenderValenceDelta,
  isSuccessfulAppraisal,
  nextBand,
  nextReserveBand,
  SENDER_VALENCE_WINDOW_MS,
  type EnergySource,
  type ReserveHistoryEntry,
} from './core.ts';
import { resolveMoodState, type ResolvedMoodState } from './state.ts';

// 同一会话两次评估至少间隔 90 秒，间隔内不评估、不排队。
export const APPRAISE_MIN_INTERVAL_MS = 90 * 1000;
// 被叫时（私聊、@、叫名字）arousal +0.05。
export const CALLED_AROUSAL_BUMP = 0.05;

export interface MoodServiceOptions {
  repository: StoreRepository;
  getConfig: () => AquariumConfig;
  getEnergySource?: (account: number) => EnergySource;
  callModel?: PipelineModelCall;
  affinityService?: AffinityService;
  now?: () => number;
  onError?: (error: unknown) => void;
}

export interface MoodService {
  promptBlocks(input: {
    account: number;
    now: number;
    template: AffectPromptTemplate;
    energy?: number;
    energySource?: EnergySource;
    record: boolean;
  }): MoodPromptBlocks;
  currentBand(input: { account: number; now: number; energySource?: EnergySource }): MoodBand;
  recordCalled(input: { account: number; sessionId: string; now: number }): void;
  afterReply(input: {
    account: number;
    sessionId: string;
    senderId: number | null;
    now: number;
    template: AppraisePromptTemplate;
    energySource?: EnergySource;
  }): Promise<void>;
  idle(): Promise<void>;
}

export function createMoodService(options: MoodServiceOptions): MoodService {
  const now = options.now ?? Date.now;
  const callModel = options.callModel ?? callSlot;
  const getEnergySource = options.getEnergySource ?? (() => 'mixed' as const);
  const lastAppraiseAt = new Map<string, number>();
  const lastCalledAt = new Map<string, number>();
  const pending = new Set<Promise<void>>();

  function loadState(account: number, at: number, energySource: EnergySource): ResolvedMoodState {
    const mood = options.getConfig().mood;
    const stored = options.repository.getMoodState(account);
    const resolvedAt = Math.max(at, stored?.updatedAt ?? at);
    const historyFrom = stored ? stored.updatedAt - 15 * 60_000 : resolvedAt - 15 * 60_000;
    return resolveMoodState({
      stored,
      at,
      settings: mood,
      energySource,
      appraisalEvents: stored ? options.repository.moodEventsSince(account, historyFrom) : [],
      replyTimes: stored ? options.repository.replyTimesForAccount(account, historyFrom, resolvedAt) : [],
    });
  }

  function saveState(account: number, state: ResolvedMoodState): void {
    options.repository.saveMoodState({
      account,
      valence: state.valence,
      arousal: state.arousal,
      updatedAt: state.updatedAt,
      band: state.band,
      bandSince: state.bandSince,
      lastBandChangeAt: state.lastBandChangeAt,
      reserve: state.reserve,
      reserveBand: state.reserveBand,
      reserveBandSince: state.reserveBandSince,
      reserveLastChangeAt: state.reserveLastChangeAt,
      lastReplyAt: state.lastReplyAt,
    });
  }

  type EventWriteFields = Omit<MoodEventRecord, 'account' | 'time' | 'dr' | 'appliedDr' | 'absorbed' | 'reserveAfter' | 'appraisalValid'>
    & Partial<Pick<MoodEventRecord, 'dr' | 'appliedDr' | 'absorbed' | 'reserveAfter' | 'appraisalValid'>>;

  function recordEvent(
    account: number,
    time: number,
    fields: EventWriteFields,
  ): void {
    options.repository.recordMoodEvent({
      account,
      time,
      dr: 0,
      appliedDr: 0,
      absorbed: 0,
      reserveAfter: null,
      appraisalValid: null,
      ...fields,
    });
  }

  function reportError(error: unknown): void {
    try {
      options.onError?.(error);
    } catch {
      // 后台任务失败不能影响回复。
    }
  }

  return {
    promptBlocks(input) {
      const moodConfig = options.getConfig().mood;
      const energySource = input.energySource ?? 'mixed';
      if (!moodConfig.enabled) {
        const float = renderFloatBlock(input.template, 0.5, input.energy ?? 1);
        return float ? { float } : {};
      }
      const current = loadState(input.account, input.now, energySource);
      const band = nextBand(current, current.valence, input.now, 'decay');
      const reserveBand = nextReserveBand({ band: current.reserveBand, bandSince: current.reserveBandSince, lastBandChangeAt: current.reserveLastChangeAt }, current.reserve, input.now, 'decay');
      let next = current;
      if (band !== current.band) {
        next = { ...next, band, bandSince: input.now, lastBandChangeAt: input.now };
        if (input.record) {
          recordEvent(input.account, input.now, {
            source: 'band', sessionId: null, senderId: null, dv: 0, da: 0,
            appliedDv: 0, appliedDa: 0, reason: 'decay',
            bandBefore: current.band, bandAfter: band,
            valenceAfter: current.valence, arousalAfter: current.arousal, reserveAfter: current.reserve,
          });
        }
      }
      if (reserveBand !== current.reserveBand) {
        next = { ...next, reserveBand, reserveBandSince: input.now, reserveLastChangeAt: input.now };
        if (input.record) {
          recordEvent(input.account, input.now, {
            source: 'band', sessionId: null, senderId: null, dv: 0, da: 0,
            appliedDv: 0, appliedDa: 0, reason: 'reserve_decay',
            bandBefore: null, bandAfter: null,
            valenceAfter: current.valence, arousalAfter: current.arousal, reserveAfter: current.reserve,
          });
        }
      }
      if (input.record && next !== current) saveState(input.account, { ...next, updatedAt: input.now });
      return renderMoodBlocks(input.template, band, current.arousal, input.energy ?? 1, reserveBand, energySource);
    },

    currentBand(input) {
      const moodConfig = options.getConfig().mood;
      if (!moodConfig.enabled) return bandOf(moodConfig.baseline.valence);
      const current = loadState(input.account, input.now, input.energySource ?? 'mixed');
      return nextBand(current, current.valence, input.now, 'decay');
    },

    recordCalled(input) {
      if (!options.getConfig().mood.enabled) return;
      const last = lastCalledAt.get(input.sessionId);
      if (last !== undefined && input.now - last < 10 * 60_000) return;
      lastCalledAt.set(input.sessionId, input.now);
      const current = loadState(input.account, input.now, getEnergySource(input.account));
      const arousal = applyArousalDelta(current.arousal, CALLED_AROUSAL_BUMP);
      saveState(input.account, { ...current, arousal, updatedAt: input.now });
      recordEvent(input.account, input.now, {
        source: 'rule',
        sessionId: input.sessionId,
        senderId: null,
        dv: 0,
        da: CALLED_AROUSAL_BUMP,
        appliedDv: 0,
        appliedDa: CALLED_AROUSAL_BUMP,
        reason: 'called',
        bandBefore: null,
        bandAfter: null,
        valenceAfter: current.valence,
        arousalAfter: arousal,
        reserveAfter: current.reserve,
      });
    },

    async afterReply(input) {
      const config = options.getConfig();
      if (!config.mood.enabled) return;
      const energySource = input.energySource ?? 'mixed';
      const current = loadState(input.account, input.now, energySource);
      const socialCost = energySource === 'inner' ? -0.01 : 0;
      const afterReply = {
        ...current,
        reserve: Math.max(0, Math.min(1, current.reserve + socialCost)),
        lastReplyAt: input.now,
        updatedAt: input.now,
      };
      if (socialCost !== 0) {
        recordEvent(input.account, input.now, {
          source: 'rule',
          sessionId: input.sessionId,
          senderId: null,
          dv: 0,
          da: 0,
          appliedDv: 0,
          appliedDa: 0,
          reason: 'social_cost',
          bandBefore: null,
          bandAfter: null,
          valenceAfter: afterReply.valence,
          arousalAfter: afterReply.arousal,
          appliedDr: socialCost,
          reserveAfter: afterReply.reserve,
        });
      }
      saveState(input.account, afterReply);
      const last = lastAppraiseAt.get(input.sessionId);
      if (last !== undefined && input.now - last < APPRAISE_MIN_INTERVAL_MS) return;

      if (budgetState(config, options.repository.costToday()) === 'exceeded') {
        recordEvent(input.account, input.now, {
          source: 'appraise',
          sessionId: input.sessionId,
          senderId: input.senderId,
          dv: 0,
          da: 0,
          appliedDv: 0,
          appliedDa: 0,
          reason: 'budget',
          appraisalValid: false,
          bandBefore: null,
          bandAfter: null,
          valenceAfter: afterReply.valence,
          arousalAfter: afterReply.arousal,
          reserveAfter: afterReply.reserve,
        });
        return;
      }
      lastAppraiseAt.set(input.sessionId, input.now);

      const task = (async () => {
        const context = options.repository.recentMessages(input.sessionId, 8).map((record) => ({
          time: record.time,
          senderName: record.senderName,
          isSelf: record.isSelf,
          plainText: record.plainText,
        }));
        const result = await runAppraise(context, input.template, (slot, messages) => callModel(slot, messages, {
          config,
          account: input.account,
          costToday: () => options.repository.costToday(),
          recordUsage: (usage) => options.repository.recordUsage({ ...usage, account: input.account }),
          now,
        }));
        const completedAt = now();

        if (!result.ok) {
          const current = loadState(input.account, completedAt, energySource);
          recordEvent(input.account, completedAt, {
            source: 'appraise',
            sessionId: input.sessionId,
            senderId: input.senderId,
            dv: 0,
            da: 0,
            appliedDv: 0,
            appliedDa: 0,
            reason: result.reason,
            appraisalValid: false,
            bandBefore: null,
            bandAfter: null,
            valenceAfter: current.valence,
            arousalAfter: current.arousal,
            reserveAfter: current.reserve,
          });
          return;
        }

        const current = loadState(input.account, completedAt, energySource);
        const history = options.repository
          .moodEventsSince(input.account, completedAt - SENDER_VALENCE_WINDOW_MS)
          .filter(isSuccessfulAppraisal)
          .map((event) => ({ time: event.time, senderId: event.senderId, appliedDv: event.appliedDv }));
        const reserveHistory: ReserveHistoryEntry[] = options.repository
          .moodEventsSince(input.account, completedAt - SENDER_VALENCE_WINDOW_MS)
          .filter(isSuccessfulAppraisal)
          .map((event) => ({ time: event.time, senderId: event.senderId, appliedDr: event.appliedDr }));
        const appliedDv = capSenderValenceDelta(result.valence, input.senderId, history, completedAt);
        const appliedReserveDelta = capSenderReserveDelta(result.reserve * 2, input.senderId, reserveHistory, completedAt);
        const positiveEnergyBonus = energySource === 'outer' ? Math.max(0, result.valence) * 0.5 : 0;
        const appliedDr = appliedReserveDelta + positiveEnergyBonus;
        const buffered = bufferNegativeDelta(appliedDv, current.reserve);
        const reserve = Math.max(0, Math.min(1, buffered.reserve + appliedDr));
        const valence = Math.max(-1, Math.min(1, current.valence + buffered.surfaceDelta));
        const arousal = applyArousalDelta(current.arousal, result.arousal);
        const band = nextBand(current, valence, completedAt, 'event');
        const reserveBand = nextReserveBand({ band: current.reserveBand, bandSince: current.reserveBandSince, lastBandChangeAt: current.reserveLastChangeAt }, reserve, completedAt, 'event');

        recordEvent(input.account, completedAt, {
          source: 'appraise',
          sessionId: input.sessionId,
          senderId: input.senderId,
          dv: result.valence,
          da: result.arousal,
          appliedDv,
          appliedDa: result.arousal,
          reason: result.reason,
          appraisalValid: true,
          bandBefore: null,
          bandAfter: null,
          valenceAfter: valence,
          arousalAfter: arousal,
          dr: result.reserve,
          appliedDr,
          absorbed: buffered.absorbed,
          reserveAfter: reserve,
        });
        options.affinityService?.recordAppraise({
          account: input.account,
          userId: input.senderId,
          sessionId: input.sessionId,
          appliedDv,
          time: completedAt,
          reason: result.reason,
        });

        let { bandSince, lastBandChangeAt, reserveBandSince, reserveLastChangeAt } = current;
        if (band !== current.band) {
          recordEvent(input.account, completedAt, {
            source: 'band',
            sessionId: input.sessionId,
            senderId: null,
            dv: 0,
            da: 0,
            appliedDv: 0,
            appliedDa: 0,
            reason: 'event',
            bandBefore: current.band,
            bandAfter: band,
            valenceAfter: valence,
            arousalAfter: arousal,
            reserveAfter: reserve,
          });
          bandSince = completedAt;
          lastBandChangeAt = completedAt;
        }
        if (reserveBand !== current.reserveBand) {
          recordEvent(input.account, completedAt, {
            source: 'band',
            sessionId: input.sessionId,
            senderId: null,
            dv: 0,
            da: 0,
            appliedDv: 0,
            appliedDa: 0,
            reason: 'reserve_event',
            bandBefore: null,
            bandAfter: null,
            valenceAfter: valence,
            arousalAfter: arousal,
            reserveAfter: reserve,
          });
          reserveBandSince = completedAt;
          reserveLastChangeAt = completedAt;
        }
        saveState(input.account, {
          ...current,
          valence,
          arousal,
          reserve,
          band,
          bandSince,
          lastBandChangeAt,
          reserveBand,
          reserveBandSince,
          reserveLastChangeAt,
          updatedAt: completedAt,
        });
      })().catch(reportError);

      pending.add(task);
      try {
        await task;
      } finally {
        pending.delete(task);
      }
    },

    async idle() {
      while (pending.size > 0) {
        await Promise.all([...pending]);
      }
    },
  };
}
