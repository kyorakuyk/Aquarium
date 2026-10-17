import type { AquariumConfig } from '../../config/schema.ts';
import type { AffinityEventRecord, AffinityStateRecord } from '../../store/affect-repo.ts';
import type { StoreRepository } from '../../store/repository.ts';
import type { AffectPromptTemplate } from '../prompt-templates.ts';
import {
  affinityLevelOf,
  appraiseAffinityDelta,
  applyDailyAffinityCap,
  canCountCalledAffinity,
  decayAffinity,
  nextAffinityLevel,
  type AffinityHistoryEntry,
  type AffinityLevel,
} from './core.ts';

const LEVELS: readonly AffinityLevel[] = ['cold', 'cool', 'neutral', 'warm', 'close'];

export interface AffinityServiceOptions {
  repository: StoreRepository;
  getConfig: () => AquariumConfig;
}

export interface AffinityService {
  recordAppraise(input: {
    account: number;
    userId: number | null;
    sessionId: string;
    appliedDv: number;
    time: number;
    reason: string;
  }): void;
  recordCalled(input: { account: number; userId: number; sessionId: string; now: number }): void;
  promptBlock(input: {
    account: number;
    userId: number;
    name: string;
    now: number;
    template: AffectPromptTemplate;
  }): string | undefined;
}

interface CurrentAffinity extends AffinityStateRecord {
  decayedFrom: AffinityLevel | null;
}

function localDayStart(now: number): number {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start.getTime();
}

function levelIndex(level: AffinityLevel): number {
  return LEVELS.indexOf(level);
}

export function createAffinityService(options: AffinityServiceOptions): AffinityService {
  function currentState(account: number, userId: number, at: number): CurrentAffinity {
    const stored = options.repository.getAffinityState(account, userId);
    const value = stored
      ? decayAffinity(stored.value, stored.lastInteractionAt, at)
      : options.getConfig().affinity.initial;
    const previousLevel = stored?.level ?? affinityLevelOf(value);
    const level = stored
      ? nextAffinityLevel({
        current: levelIndex(stored.level),
        since: stored.levelSince,
        lastChangeAt: stored.lastLevelChangeAt,
      }, value, at, 'decay')
      : previousLevel;
    const levelChanged = level !== previousLevel;
    return {
      account,
      userId,
      value,
      level,
      levelSince: levelChanged ? at : stored?.levelSince ?? at,
      lastLevelChangeAt: levelChanged ? at : stored?.lastLevelChangeAt ?? at,
      lastInteractionAt: stored?.lastInteractionAt ?? at,
      updatedAt: stored?.updatedAt ?? at,
      decayedFrom: levelChanged ? previousLevel : null,
    };
  }

  function todayHistory(account: number, userId: number, at: number): AffinityHistoryEntry[] {
    return options.repository.affinityEventsSince(account, userId, localDayStart(at))
      .filter((event) => event.time <= at)
      .map(({ time, source, applied }) => ({ time, source, applied }));
  }

  function recordEvent(event: AffinityEventRecord): void {
    options.repository.recordAffinityEvent(event);
  }

  function recordBand(
    state: CurrentAffinity,
    time: number,
    sessionId: string | null,
    reason: 'decay' | 'event',
    before: AffinityLevel,
    after: AffinityLevel,
  ): void {
    recordEvent({
      account: state.account,
      userId: state.userId,
      time,
      source: 'band',
      sessionId,
      delta: 0,
      applied: 0,
      reason,
      levelBefore: before,
      levelAfter: after,
    });
  }

  function applyAutomaticEvent(input: {
    current: CurrentAffinity;
    time: number;
    sessionId: string;
    source: 'appraise' | 'called';
    delta: number;
    applied: number;
    reason: string;
  }): void {
    const { current, time, sessionId, source, delta, applied, reason } = input;
    const stored = options.repository.getAffinityState(current.account, current.userId);
    if (current.decayedFrom && stored) {
      recordBand(current, time, sessionId, 'decay', current.decayedFrom, current.level);
    }
    const value = Math.max(0, Math.min(100, current.value + applied));
    const level = nextAffinityLevel({
      current: levelIndex(current.level),
      since: current.levelSince,
      lastChangeAt: current.lastLevelChangeAt,
    }, value, time, 'event');
    recordEvent({
      account: current.account,
      userId: current.userId,
      time,
      source,
      sessionId,
      delta,
      applied,
      reason,
      levelBefore: null,
      levelAfter: null,
    });
    let { levelSince, lastLevelChangeAt } = current;
    if (level !== current.level) {
      recordBand(current, time, sessionId, 'event', current.level, level);
      levelSince = time;
      lastLevelChangeAt = time;
    }
    options.repository.saveAffinityState({
      account: current.account,
      userId: current.userId,
      value,
      level,
      levelSince,
      lastLevelChangeAt,
      lastInteractionAt: time,
      updatedAt: time,
    });
  }

  return {
    recordAppraise(input) {
      const config = options.getConfig();
      if (!config.affinity.enabled || input.userId === null || input.userId === input.account || input.appliedDv === 0) return;
      const delta = appraiseAffinityDelta(input.appliedDv);
      const current = currentState(input.account, input.userId, input.time);
      const history = todayHistory(input.account, input.userId, input.time);
      const applied = applyDailyAffinityCap(delta, history, input.time);
      applyAutomaticEvent({
        current,
        time: input.time,
        sessionId: input.sessionId,
        source: 'appraise',
        delta,
        applied,
        reason: input.reason,
      });
    },

    recordCalled(input) {
      const config = options.getConfig();
      if (!config.affinity.enabled || input.userId === input.account) return;
      const history = todayHistory(input.account, input.userId, input.now);
      if (!canCountCalledAffinity(history, input.now)) return;
      const current = currentState(input.account, input.userId, input.now);
      const delta = 0.5;
      const applied = applyDailyAffinityCap(delta, history, input.now);
      applyAutomaticEvent({
        current,
        time: input.now,
        sessionId: input.sessionId,
        source: 'called',
        delta,
        applied,
        reason: 'called',
      });
    },

    promptBlock(input) {
      if (!options.getConfig().affinity.enabled || input.userId === input.account) return undefined;
      const current = currentState(input.account, input.userId, input.now);
      if (current.level === 'neutral') return undefined;
      return input.template.affinity[current.level].replaceAll('{{name}}', JSON.stringify(input.name));
    },
  };
}
