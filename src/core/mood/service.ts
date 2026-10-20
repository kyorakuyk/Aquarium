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
  capSenderValenceDelta,
  clampMood,
  decayValue,
  nextBand,
  SENDER_VALENCE_WINDOW_MS,
} from './core.ts';

// 同一会话两次评估至少间隔 90 秒，间隔内不评估、不排队。
export const APPRAISE_MIN_INTERVAL_MS = 90 * 1000;
// 被叫时（私聊、@、叫名字）arousal +0.05。
export const CALLED_AROUSAL_BUMP = 0.05;

export interface MoodServiceOptions {
  repository: StoreRepository;
  getConfig: () => AquariumConfig;
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
    record: boolean;
  }): MoodPromptBlocks;
  currentBand(input: { account: number; now: number }): MoodBand;
  recordCalled(input: { account: number; sessionId: string; now: number }): void;
  afterReply(input: {
    account: number;
    sessionId: string;
    senderId: number | null;
    now: number;
    template: AppraisePromptTemplate;
  }): Promise<void>;
  idle(): Promise<void>;
}

interface ResolvedMoodState {
  valence: number;
  arousal: number;
  band: MoodBand;
  bandSince: number;
  lastBandChangeAt: number;
}

export function createMoodService(options: MoodServiceOptions): MoodService {
  const now = options.now ?? Date.now;
  const callModel = options.callModel ?? callSlot;
  const lastAppraiseAt = new Map<string, number>();
  const pending = new Set<Promise<void>>();

  function loadState(account: number, at: number): ResolvedMoodState {
    const mood = options.getConfig().mood;
    const stored = options.repository.getMoodState(account);
    if (!stored) {
      return {
        valence: mood.baseline.valence,
        arousal: mood.baseline.arousal,
        band: bandOf(mood.baseline.valence),
        bandSince: at,
        lastBandChangeAt: at,
      };
    }
    return {
      valence: decayValue(stored.valence, mood.baseline.valence, at - stored.updatedAt, mood.halfLifeMin),
      arousal: decayValue(stored.arousal, mood.baseline.arousal, at - stored.updatedAt, mood.halfLifeMin),
      band: stored.band,
      bandSince: stored.bandSince,
      lastBandChangeAt: stored.lastBandChangeAt,
    };
  }

  function saveState(account: number, at: number, state: ResolvedMoodState): void {
    options.repository.saveMoodState({
      account,
      valence: state.valence,
      arousal: state.arousal,
      updatedAt: at,
      band: state.band,
      bandSince: state.bandSince,
      lastBandChangeAt: state.lastBandChangeAt,
    });
  }

  function recordEvent(
    account: number,
    time: number,
    fields: Omit<MoodEventRecord, 'account' | 'time'>,
  ): void {
    options.repository.recordMoodEvent({ account, time, ...fields });
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
      if (!moodConfig.enabled) {
        const float = renderFloatBlock(input.template, 0.5, input.energy ?? 1);
        return float ? { float } : {};
      }
      const current = loadState(input.account, input.now);
      const band = nextBand(current, current.valence, input.now, 'decay');
      if (band !== current.band && input.record) {
        recordEvent(input.account, input.now, {
          source: 'band',
          sessionId: null,
          senderId: null,
          dv: 0,
          da: 0,
          appliedDv: 0,
          appliedDa: 0,
          reason: 'decay',
          bandBefore: current.band,
          bandAfter: band,
          valenceAfter: current.valence,
          arousalAfter: current.arousal,
        });
        saveState(input.account, input.now, {
          ...current,
          band,
          bandSince: input.now,
          lastBandChangeAt: input.now,
        });
      }
      return renderMoodBlocks(input.template, band, current.arousal, input.energy ?? 1);
    },

    currentBand(input) {
      if (!options.getConfig().mood.enabled) return bandOf(options.getConfig().mood.baseline.valence);
      return loadState(input.account, input.now).band;
    },

    recordCalled(input) {
      if (!options.getConfig().mood.enabled) return;
      const current = loadState(input.account, input.now);
      const arousal = clampMood(current.valence, current.arousal + CALLED_AROUSAL_BUMP).arousal;
      saveState(input.account, input.now, { ...current, arousal });
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
      });
    },

    async afterReply(input) {
      const config = options.getConfig();
      if (!config.mood.enabled) return;

      const last = lastAppraiseAt.get(input.sessionId);
      if (last !== undefined && input.now - last < APPRAISE_MIN_INTERVAL_MS) return;

      if (budgetState(config, options.repository.costToday()) === 'exceeded') {
        const current = loadState(input.account, input.now);
        recordEvent(input.account, input.now, {
          source: 'appraise',
          sessionId: input.sessionId,
          senderId: input.senderId,
          dv: 0,
          da: 0,
          appliedDv: 0,
          appliedDa: 0,
          reason: 'budget',
          bandBefore: null,
          bandAfter: null,
          valenceAfter: current.valence,
          arousalAfter: current.arousal,
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
          const current = loadState(input.account, completedAt);
          recordEvent(input.account, completedAt, {
            source: 'appraise',
            sessionId: input.sessionId,
            senderId: input.senderId,
            dv: 0,
            da: 0,
            appliedDv: 0,
            appliedDa: 0,
            reason: result.reason,
            bandBefore: null,
            bandAfter: null,
            valenceAfter: current.valence,
            arousalAfter: current.arousal,
          });
          return;
        }

        const current = loadState(input.account, completedAt);
        const history = options.repository
          .moodEventsSince(input.account, completedAt - SENDER_VALENCE_WINDOW_MS)
          .map((event) => ({ time: event.time, senderId: event.senderId, appliedDv: event.appliedDv }));
        const appliedDv = capSenderValenceDelta(result.valence, input.senderId, history, completedAt);
        const clamped = clampMood(current.valence + appliedDv, current.arousal + result.arousal);
        const band = nextBand(current, clamped.valence, completedAt, 'event');

        recordEvent(input.account, completedAt, {
          source: 'appraise',
          sessionId: input.sessionId,
          senderId: input.senderId,
          dv: result.valence,
          da: result.arousal,
          appliedDv,
          appliedDa: result.arousal,
          reason: result.reason,
          bandBefore: null,
          bandAfter: null,
          valenceAfter: clamped.valence,
          arousalAfter: clamped.arousal,
        });
        options.affinityService?.recordAppraise({
          account: input.account,
          userId: input.senderId,
          sessionId: input.sessionId,
          appliedDv,
          time: completedAt,
          reason: result.reason,
        });

        let { bandSince, lastBandChangeAt } = current;
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
            valenceAfter: clamped.valence,
            arousalAfter: clamped.arousal,
          });
          bandSince = completedAt;
          lastBandChangeAt = completedAt;
        }
        saveState(input.account, completedAt, {
          valence: clamped.valence,
          arousal: clamped.arousal,
          band,
          bandSince,
          lastBandChangeAt,
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
