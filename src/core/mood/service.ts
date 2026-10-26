import type { AquariumConfig } from '../../config/schema.ts';
import { canCallWithDailyBudget } from '../../llm/budget.ts';
import { callSlot } from '../../llm/slots.ts';
import type { MoodBand, MoodEventRecord } from '../../store/affect-repo.ts';
import type { StoreRepository } from '../../store/repository.ts';
import type { AffinityService } from '../affinity/service.ts';
import { resolveEnergyMultiplier, type PersonaEnergyMultipliers } from '../../persona/energy.ts';
import { DEFAULT_PERSONA_MOOD, type PersonaMoodSettings } from '../../persona/mood.ts';
import type { AffectPromptTemplate, AppraisePromptTemplate } from '../prompt/templates.ts';
import type { PipelineModelCall } from '../conversation/steps/types.ts';
import { runAppraise } from './appraise.ts';
import { renderFloatBlock, renderMoodBlocks, type MoodPromptBlocks } from './render.ts';
import {
  bandOf,
  applyArousalDelta,
  applyDominanceDelta,
  bufferNegativeDelta,
  capSenderReserveDelta,
  capSenderValenceDelta,
  isSuccessfulAppraisal,
  reanchor,
  resolveConfiguredMoodEmotions,
  nextReserveBand,
  SENDER_VALENCE_WINDOW_MS,
  type EnergySource,
  type ReserveHistoryEntry,
} from './core.ts';
import { eventAnchorFields, reanchorMoodValues } from './anchors.ts';
import { resolveMoodSettings } from './settings.ts';
import { resolveMoodState, type ResolvedMoodState } from './state.ts';

// 同一会话两次评估至少间隔 90 秒，间隔内不评估、不排队。
export const APPRAISE_MIN_INTERVAL_MS = 90 * 1000;
// 被叫时（私聊、@、叫名字）arousal +0.05。
export const CALLED_AROUSAL_BUMP = 0.05;

export interface MoodServiceOptions {
  repository: StoreRepository;
  getConfig: () => AquariumConfig;
  getEnergySource?: (account: number) => EnergySource;
  getEnergyMultipliers?: (account: number) => PersonaEnergyMultipliers;
  getPersonaMoodSettings?: (account: number) => PersonaMoodSettings;
  callModel?: PipelineModelCall;
  affinityService?: AffinityService;
  now?: () => number;
  onError?: (error: unknown) => void;
}

export interface MoodService {
  promptBlocks(input: {
    account: number;
    messageId?: string;
    moodSettings?: PersonaMoodSettings;
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
    messageId: string;
    innerVoice?: string;
    moodSettings?: PersonaMoodSettings;
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
  const getPersonaMoodSettings = options.getPersonaMoodSettings ?? (() => DEFAULT_PERSONA_MOOD);
  const lastAppraiseAt = new Map<string, number>();
  const lastCalledAt = new Map<string, number>();
  const pending = new Set<Promise<void>>();

  function effectiveMoodSettings(account: number, override?: PersonaMoodSettings) {
    let personaSettings = override;
    if (!personaSettings) {
      try { personaSettings = getPersonaMoodSettings(account); } catch { personaSettings = DEFAULT_PERSONA_MOOD; }
    }
    return resolveMoodSettings(options.getConfig().mood, personaSettings);
  }

  function loadState(
    account: number,
    at: number,
    energySource: EnergySource,
    mood = effectiveMoodSettings(account),
  ): ResolvedMoodState {
    const stored = options.repository.getMoodState(account);
    const resolvedAt = Math.max(at, stored?.updatedAt ?? at);
    const historyFrom = stored ? stored.updatedAt - 15 * 60_000 : resolvedAt - 15 * 60_000;
    return resolveMoodState({
      stored,
      at,
      settings: mood,
      energySource,
      energyMultipliers: options.getEnergyMultipliers?.(account),
      appraisalEvents: stored ? options.repository.moodEventsSince(account, historyFrom) : [],
      replyTimes: stored ? options.repository.replyTimesForAccount(account, historyFrom, resolvedAt) : [],
    });
  }

  function saveState(account: number, state: ResolvedMoodState): void {
    options.repository.saveMoodState({
      account,
      valence: state.valence,
      arousal: state.arousal,
      dominance: state.dominance,
      valenceD0: state.valenceD0,
      valenceU: state.valenceU,
      arousalD0: state.arousalD0,
      arousalU: state.arousalU,
      dominanceD0: state.dominanceD0,
      dominanceU: state.dominanceU,
      updatedAt: state.updatedAt,
      band: state.band,
      bandSince: state.bandSince,
      lastBandChangeAt: state.lastBandChangeAt,
      mainEmotion: state.mainEmotion,
      emotionSince: state.emotionSince,
      lastEmotionChangeAt: state.lastEmotionChangeAt,
      reserve: state.reserve,
      reserveBand: state.reserveBand,
      reserveBandSince: state.reserveBandSince,
      reserveLastChangeAt: state.reserveLastChangeAt,
      lastReplyAt: state.lastReplyAt,
    });
  }

  function resolveEmotions(
    state: ResolvedMoodState,
    account: number,
    at: number,
    messageId: string,
    settingsOverride?: PersonaMoodSettings,
  ): { state: ResolvedMoodState; subEmotions: string[] } {
    let settings = settingsOverride ?? DEFAULT_PERSONA_MOOD;
    if (!settingsOverride) {
      try { settings = getPersonaMoodSettings(account); } catch { settings = DEFAULT_PERSONA_MOOD; }
    }
    const emotions = resolveConfiguredMoodEmotions({
      state,
      settings,
      currentEmotion: state.mainEmotion,
      emotionSince: state.emotionSince,
      lastEmotionChangeAt: state.lastEmotionChangeAt,
      now: at,
      messageId,
    });
    return {
      state: {
        ...state,
        mainEmotion: emotions.mainEmotion,
        emotionSince: emotions.emotionSince,
        lastEmotionChangeAt: emotions.lastEmotionChangeAt,
      },
      subEmotions: emotions.subEmotions,
    };
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
      const current = loadState(
        input.account,
        input.now,
        energySource,
        effectiveMoodSettings(input.account, input.moodSettings),
      );
      const resolvedEmotion = resolveEmotions(current, input.account, input.now, input.messageId ?? '', input.moodSettings);
      const emotionState = resolvedEmotion.state;
      const band = bandOf(current.valence, current.arousal);
      const reserveBand = nextReserveBand({ band: current.reserveBand, bandSince: current.reserveBandSince, lastBandChangeAt: current.reserveLastChangeAt }, current.reserve, input.now, 'decay');
      const regionChanged = band !== current.band;
      const reserveChanged = reserveBand !== current.reserveBand;
      const emotionChanged = emotionState.mainEmotion !== current.mainEmotion
        || emotionState.emotionSince !== current.emotionSince
        || emotionState.lastEmotionChangeAt !== current.lastEmotionChangeAt;
      const next: ResolvedMoodState = {
        ...emotionState,
        band,
        bandSince: regionChanged ? input.now : current.bandSince,
        lastBandChangeAt: regionChanged ? input.now : current.lastBandChangeAt,
        reserveBand,
        reserveBandSince: reserveChanged ? input.now : current.reserveBandSince,
        reserveLastChangeAt: reserveChanged ? input.now : current.reserveLastChangeAt,
      };
      if (regionChanged) {
        if (input.record) {
          recordEvent(input.account, input.now, {
            source: 'band', sessionId: null, senderId: null, dv: 0, da: 0,
            dd: 0, appliedDv: 0, appliedDa: 0, appliedDd: 0,
            dominanceAfter: current.dominance, causeTag: null, reason: 'decay',
            bandBefore: current.band, bandAfter: band,
            valenceAfter: current.valence, arousalAfter: current.arousal,
            reserveAfter: current.reserve,
            ...eventAnchorFields(current),
          });
        }
      }
      if (reserveChanged) {
        if (input.record) {
          recordEvent(input.account, input.now, {
            source: 'band', sessionId: null, senderId: null, dv: 0, da: 0,
            dd: 0, appliedDv: 0, appliedDa: 0, appliedDd: 0,
            dominanceAfter: current.dominance, causeTag: null, reason: 'reserve_decay',
            bandBefore: null, bandAfter: null,
            valenceAfter: current.valence, arousalAfter: current.arousal,
            reserveAfter: current.reserve,
            ...eventAnchorFields(current),
          });
        }
      }
      if (input.record && (regionChanged || reserveChanged || emotionChanged)) {
        saveState(input.account, { ...next, updatedAt: input.now });
      }
      return renderMoodBlocks(input.template, {
        mainEmotion: next.mainEmotion ?? '平静',
        subEmotions: resolvedEmotion.subEmotions,
      }, current.arousal, input.energy ?? 1, reserveBand, energySource);
    },

    currentBand(input) {
      const moodConfig = options.getConfig().mood;
      if (!moodConfig.enabled) return bandOf(moodConfig.baseline.valence, moodConfig.baseline.arousal);
      const current = loadState(input.account, input.now, input.energySource ?? 'mixed');
      return bandOf(current.valence, current.arousal);
    },

    recordCalled(input) {
      const moodConfig = options.getConfig().mood;
      if (!moodConfig.enabled) return;
      const last = lastCalledAt.get(input.sessionId);
      if (last !== undefined && input.now - last < 10 * 60_000) return;
      lastCalledAt.set(input.sessionId, input.now);
      const settings = effectiveMoodSettings(input.account);
      const current = loadState(input.account, input.now, getEnergySource(input.account), settings);
      const arousal = applyArousalDelta(current.arousal, CALLED_AROUSAL_BUMP);
      const arousalAnchor = reanchor(
        current.arousal - settings.baseline.arousal,
        arousal - settings.baseline.arousal,
        current.arousalU,
        settings.arousalHoldShape,
      );
      const next = {
        ...current,
        arousal,
        arousalD0: arousalAnchor.d0,
        arousalU: arousalAnchor.u,
        updatedAt: input.now,
      };
      saveState(input.account, next);
      recordEvent(input.account, input.now, {
        source: 'rule',
        sessionId: input.sessionId,
        senderId: null,
        dv: 0,
        da: CALLED_AROUSAL_BUMP,
        dd: 0,
        appliedDv: 0,
        appliedDa: CALLED_AROUSAL_BUMP,
        appliedDd: 0,
        dominanceAfter: current.dominance,
        causeTag: null,
        reason: 'called',
        bandBefore: null,
        bandAfter: null,
        valenceAfter: current.valence,
        arousalAfter: arousal,
        reserveAfter: current.reserve,
        ...eventAnchorFields(next),
      });
    },

    async afterReply(input) {
      const config = options.getConfig();
      if (!config.mood.enabled) return;
      const energySource = input.energySource ?? 'mixed';
      const settings = effectiveMoodSettings(input.account, input.moodSettings);
      const current = resolveEmotions(
        loadState(input.account, input.now, energySource, settings),
        input.account,
        input.now,
        input.messageId,
        input.moodSettings,
      ).state;
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
          dd: 0,
          appliedDv: 0,
          appliedDa: 0,
          appliedDd: 0,
          dominanceAfter: afterReply.dominance,
          causeTag: null,
          reason: 'social_cost',
          bandBefore: null,
          bandAfter: null,
          valenceAfter: afterReply.valence,
          arousalAfter: afterReply.arousal,
          appliedDr: socialCost,
          reserveAfter: afterReply.reserve,
          ...eventAnchorFields(afterReply),
        });
      }
      saveState(input.account, afterReply);
      const last = lastAppraiseAt.get(input.sessionId);
      if (last !== undefined && input.now - last < APPRAISE_MIN_INTERVAL_MS) return;

      if (!canCallWithDailyBudget(config, 'extract', options.repository.costToday())) {
        recordEvent(input.account, input.now, {
          source: 'appraise',
          sessionId: input.sessionId,
          senderId: input.senderId,
          dv: 0,
          da: 0,
          dd: 0,
          appliedDv: 0,
          appliedDa: 0,
          appliedDd: 0,
          dominanceAfter: afterReply.dominance,
          causeTag: null,
          reason: 'budget',
          appraisalValid: false,
          bandBefore: null,
          bandAfter: null,
          valenceAfter: afterReply.valence,
          arousalAfter: afterReply.arousal,
          reserveAfter: afterReply.reserve,
          ...eventAnchorFields(afterReply),
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
        }), input.innerVoice);
        const completedAt = now();

        if (!result.ok) {
          const current = resolveEmotions(
            loadState(input.account, completedAt, energySource, settings),
            input.account,
            completedAt,
            input.messageId,
            input.moodSettings,
          ).state;
          recordEvent(input.account, completedAt, {
            source: 'appraise',
            sessionId: input.sessionId,
            senderId: input.senderId,
            dv: 0,
            da: 0,
            dd: 0,
            appliedDv: 0,
            appliedDa: 0,
            appliedDd: 0,
            dominanceAfter: current.dominance,
            causeTag: null,
            reason: result.reason,
            appraisalValid: false,
            bandBefore: null,
            bandAfter: null,
            valenceAfter: current.valence,
            arousalAfter: current.arousal,
            reserveAfter: current.reserve,
            ...eventAnchorFields(current),
          });
          return;
        }

        const current = resolveEmotions(
          loadState(input.account, completedAt, energySource, settings),
          input.account,
          completedAt,
          input.messageId,
          input.moodSettings,
        ).state;
        const history = options.repository
          .moodEventsSince(input.account, completedAt - SENDER_VALENCE_WINDOW_MS)
          .filter(isSuccessfulAppraisal)
          .map((event) => ({ time: event.time, senderId: event.senderId, appliedDv: event.appliedDv }));
        const reserveHistory: ReserveHistoryEntry[] = options.repository
          .moodEventsSince(input.account, completedAt - SENDER_VALENCE_WINDOW_MS)
          .filter(isSuccessfulAppraisal)
          .map((event) => ({ time: event.time, senderId: event.senderId, appliedDr: event.appliedDr }));
        const appliedDv = capSenderValenceDelta(result.valence, input.senderId, history, completedAt);
        const energyMultipliers = options.getEnergyMultipliers?.(input.account);
        const reserveMultiplier = resolveEnergyMultiplier(
          energyMultipliers,
          result.reserve >= 0 ? 'warmCharge' : 'hurtCost',
        );
        const appliedReserveDelta = capSenderReserveDelta(
          result.reserve * 2 * reserveMultiplier,
          input.senderId,
          reserveHistory,
          completedAt,
          energyMultipliers,
        );
        const positiveEnergyBonus = energySource === 'outer' ? Math.max(0, result.valence) * 0.5 : 0;
        const appliedDr = appliedReserveDelta + positiveEnergyBonus;
        const buffered = bufferNegativeDelta(appliedDv, current.reserve, energyMultipliers);
        const reserve = Math.max(0, Math.min(1, buffered.reserve + appliedDr));
        const valence = Math.max(-1, Math.min(1, current.valence + buffered.surfaceDelta));
        const arousal = applyArousalDelta(current.arousal, result.arousal);
        const dominance = applyDominanceDelta(current.dominance, result.dominance);
        const anchored = {
          ...current,
          ...reanchorMoodValues(current, { valence, arousal, dominance }, config.mood.baseline, settings),
        };
        const appliedDd = dominance - current.dominance;
        const band = bandOf(valence, arousal);
        const emotionState = resolveEmotions(
          anchored,
          input.account,
          completedAt,
          input.messageId,
          input.moodSettings,
        ).state;
        const reserveBand = nextReserveBand({ band: current.reserveBand, bandSince: current.reserveBandSince, lastBandChangeAt: current.reserveLastChangeAt }, reserve, completedAt, 'event');

        recordEvent(input.account, completedAt, {
          source: 'appraise',
          sessionId: input.sessionId,
          senderId: input.senderId,
          dv: result.valence,
          da: result.arousal,
          dd: result.dominance,
          appliedDv,
          appliedDa: result.arousal,
          appliedDd,
          dominanceAfter: dominance,
          causeTag: result.causeTag,
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
          ...eventAnchorFields(emotionState),
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
            dd: 0,
            appliedDv: 0,
            appliedDa: 0,
            appliedDd: 0,
            dominanceAfter: dominance,
            causeTag: null,
            reason: 'event',
            bandBefore: current.band,
            bandAfter: band,
            valenceAfter: valence,
            arousalAfter: arousal,
            reserveAfter: reserve,
            ...eventAnchorFields(emotionState),
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
            dd: 0,
            appliedDv: 0,
            appliedDa: 0,
            appliedDd: 0,
            dominanceAfter: dominance,
            causeTag: null,
            reason: 'reserve_event',
            bandBefore: null,
            bandAfter: null,
            valenceAfter: valence,
            arousalAfter: arousal,
            reserveAfter: reserve,
            ...eventAnchorFields(emotionState),
          });
          reserveBandSince = completedAt;
          reserveLastChangeAt = completedAt;
        }
        saveState(input.account, {
          ...emotionState,
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
