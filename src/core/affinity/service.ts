import type { AquariumConfig } from '../../config/schema.ts';
import type {
  AffinityEventRecord,
  AffinityStateRecord,
  StoredAffinityEvent,
} from '../../store/affect-repo.ts';
import type {
  PersonaAffinityEventRecord,
  PersonaAffinityStateRecord,
  StoredPersonaAffinityEvent,
} from '../../store/persona-affinity-repo.ts';
import type { StoreRepository } from '../../store/repository.ts';
import type { PersonaAffinitySettings } from '../../persona/affinity.ts';
import type { AffectPromptTemplate } from '../prompt/templates.ts';
import {
  AFFINITY_LEVELS,
  affinityLevelOf,
  appraiseAffinityDelta,
  applyDailyAffinityCap,
  canCountCalledAffinity,
  decayAffinity,
  nextAffinityLevel,
  type AffinityHistoryEntry,
  type AffinityLevel,
  type AffinityTiers,
} from './core.ts';
import { affinityMultiplier, resolveAffinityCurves, type AffinityCurveSet } from './curves.ts';

const LEVELS = AFFINITY_LEVELS;

export interface AffinityServiceOptions {
  repository: StoreRepository;
  getConfig: () => AquariumConfig;
  getPersonaAffinity?: (personaId: string) => PersonaAffinitySettings;
}

export interface AffinityCurrentView {
  userId: number;
  value: number;
  level: AffinityLevel;
  lastInteractionAt: number | null;
  personaId: string;
  mode: 'inherit' | 'independent';
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
  getCurrent(account: number, userId: number, now: number): AffinityCurrentView;
  listCurrent(account: number, now: number): AffinityCurrentView[];
  setManual(input: { account: number; userId: number; value: number; now: number }): AffinityCurrentView;
  recentEvents(account: number, userId: number, count: number): Array<StoredAffinityEvent | StoredPersonaAffinityEvent>;
}

interface AffinityScope {
  personaId: string;
  mode: 'inherit' | 'independent';
  start: number;
  tiers: AffinityTiers;
  curves: AffinityCurveSet;
}

interface CurrentAffinity extends Omit<AffinityStateRecord, 'lastInteractionAt'> {
  lastInteractionAt: number | null;
  decayedFrom: AffinityLevel | null;
  scope: AffinityScope;
}

function localDayStart(now: number): number {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start.getTime();
}

function roundAffinity(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function levelIndex(level: AffinityLevel): number {
  return LEVELS.indexOf(level);
}

export function createAffinityService(options: AffinityServiceOptions): AffinityService {
  const mainUserId = (account: number, userId: number): number => options.repository.mainUserIdFor(account, userId);

  function scopeFor(account: number, config: AquariumConfig): AffinityScope {
    const personaId = config.accounts.find((entry) => entry.uin === account)?.persona ?? 'default';
    const persona = options.getPersonaAffinity?.(personaId) ?? { mode: 'inherit' as const };
    const configuredTiers = persona.tiers ?? config.affinity.tiers;
    return {
      personaId,
      mode: persona.mode,
      start: config.affinity.start,
      tiers: {
        positive: configuredTiers.positive as unknown as AffinityTiers['positive'],
        negative: configuredTiers.negative as unknown as AffinityTiers['negative'],
      },
      curves: resolveAffinityCurves(config.affinity.curveDefaults, persona.curves),
    };
  }

  function storedState(account: number, userId: number, scope: AffinityScope) {
    return scope.mode === 'independent'
      ? options.repository.getPersonaAffinityState(account, userId, scope.personaId)
      : options.repository.getAffinityState(account, userId);
  }

  function saveState(state: AffinityStateRecord, scope: AffinityScope): void {
    if (scope.mode === 'independent') {
      options.repository.savePersonaAffinityState({ ...state, personaId: scope.personaId });
    } else {
      options.repository.saveAffinityState(state);
    }
  }

  function currentState(account: number, userId: number, at: number, scope: AffinityScope): CurrentAffinity {
    const stored = storedState(account, userId, scope);
    const value = stored
      ? stored.lastInteractionAt > 0 ? decayAffinity(stored.value, stored.lastInteractionAt, at, scope.start) : stored.value
      : scope.start;
    const previousLevel = stored?.level ?? affinityLevelOf(value, scope.tiers);
    const level = stored
      ? nextAffinityLevel({
        current: levelIndex(stored.level),
        since: stored.levelSince,
        lastChangeAt: stored.lastLevelChangeAt,
      }, value, at, 'decay', scope.tiers)
      : previousLevel;
    const levelChanged = level !== previousLevel;
    return {
      account,
      userId,
      value,
      level,
      levelSince: levelChanged ? at : stored?.levelSince ?? at,
      lastLevelChangeAt: levelChanged ? at : stored?.lastLevelChangeAt ?? at,
      lastInteractionAt: stored && stored.lastInteractionAt > 0 ? stored.lastInteractionAt : null,
      updatedAt: stored?.updatedAt ?? at,
      decayedFrom: levelChanged ? previousLevel : null,
      scope,
    };
  }

  function currentView(state: CurrentAffinity): AffinityCurrentView {
    return {
      userId: state.userId,
      value: state.value,
      level: state.level,
      lastInteractionAt: state.lastInteractionAt,
      personaId: state.scope.personaId,
      mode: state.scope.mode,
    };
  }

  function eventsSince(account: number, userId: number, since: number, scope: AffinityScope) {
    return scope.mode === 'independent'
      ? options.repository.personaAffinityEventsSince(account, userId, scope.personaId, since)
      : options.repository.affinityEventsSince(account, userId, since);
  }

  function todayHistory(account: number, userId: number, at: number, scope: AffinityScope): AffinityHistoryEntry[] {
    return eventsSince(account, userId, localDayStart(at), scope)
      .filter((event) => event.time <= at)
      .map(({ time, source, applied }) => ({ time, source, applied }));
  }

  function recordEvent(event: AffinityEventRecord, scope: AffinityScope): void {
    if (scope.mode === 'independent') {
      const personaEvent: PersonaAffinityEventRecord = { ...event, personaId: scope.personaId };
      options.repository.recordPersonaAffinityEvent(personaEvent);
    } else {
      options.repository.recordAffinityEvent(event);
    }
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
    }, state.scope);
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
    const stored = storedState(current.account, current.userId, current.scope);
    if (current.decayedFrom && stored) {
      recordBand(current, time, sessionId, 'decay', current.decayedFrom, current.level);
    }
    const value = roundAffinity(Math.max(-100, Math.min(100, current.value + applied)));
    const level = nextAffinityLevel({
      current: levelIndex(current.level),
      since: current.levelSince,
      lastChangeAt: current.lastLevelChangeAt,
    }, value, time, 'event', current.scope.tiers);
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
    }, current.scope);
    let { levelSince, lastLevelChangeAt } = current;
    if (level !== current.level) {
      recordBand(current, time, sessionId, 'event', current.level, level);
      levelSince = time;
      lastLevelChangeAt = time;
    }
    saveState({
      account: current.account,
      userId: current.userId,
      value,
      level,
      levelSince,
      lastLevelChangeAt,
      lastInteractionAt: time,
      updatedAt: time,
    }, current.scope);
  }

  return {
    recordAppraise(input) {
      const config = options.getConfig();
      if (!config.affinity.enabled || input.userId === null || input.appliedDv === 0) return;
      const userId = mainUserId(input.account, input.userId);
      if (userId === input.account) return;
      const scope = scopeFor(input.account, config);
      const current = currentState(input.account, userId, input.time, scope);
      const baseDelta = appraiseAffinityDelta(input.appliedDv);
      const delta = roundAffinity(baseDelta * affinityMultiplier(
        current.value,
        baseDelta,
        scope.curves,
        scope.tiers,
      ));
      const history = todayHistory(input.account, userId, input.time, scope);
      const applied = roundAffinity(applyDailyAffinityCap(delta, history, input.time));
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
      const userId = mainUserId(input.account, input.userId);
      if (!config.affinity.enabled || userId === input.account) return;
      const scope = scopeFor(input.account, config);
      const history = todayHistory(input.account, userId, input.now, scope);
      if (!canCountCalledAffinity(history, input.now)) return;
      const current = currentState(input.account, userId, input.now, scope);
      const delta = roundAffinity(0.5 * affinityMultiplier(current.value, 0.5, scope.curves, scope.tiers));
      const applied = roundAffinity(applyDailyAffinityCap(delta, history, input.now));
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
      const config = options.getConfig();
      const userId = mainUserId(input.account, input.userId);
      if (!config.affinity.enabled || userId === input.account) return undefined;
      const current = currentState(input.account, userId, input.now, scopeFor(input.account, config));
      return input.template.affinity[current.level].replaceAll('{{name}}', JSON.stringify(input.name));
    },

    getCurrent(account, userId, at) {
      const config = options.getConfig();
      return currentView(currentState(account, mainUserId(account, userId), at, scopeFor(account, config)));
    },

    listCurrent(account, at) {
      const config = options.getConfig();
      const scope = scopeFor(account, config);
      const userIds = new Set(options.repository.listAffinityStates(account)
        .map((state) => mainUserId(account, state.userId)));
      if (scope.mode === 'independent') {
        for (const state of options.repository.listPersonaAffinityStates(account, scope.personaId)) {
          userIds.add(mainUserId(account, state.userId));
        }
      }
      return [...userIds].map((userId) => currentView(currentState(account, userId, at, scope)));
    },

    setManual(input) {
      if (!Number.isSafeInteger(input.value) || input.value < -100 || input.value > 100) {
        throw new RangeError('好感度必须是 −100–100 的整数');
      }
      const userId = mainUserId(input.account, input.userId);
      const config = options.getConfig();
      const scope = scopeFor(input.account, config);
      const stored = storedState(input.account, userId, scope);
      const current = currentState(input.account, userId, input.now, scope);
      const level = affinityLevelOf(input.value, scope.tiers);
      const levelChanged = level !== current.level;
      const delta = roundAffinity(input.value - current.value);
      recordEvent({
        account: input.account,
        userId,
        time: input.now,
        source: 'manual',
        sessionId: null,
        delta,
        applied: delta,
        reason: 'manual',
        levelBefore: current.level,
        levelAfter: level,
      }, scope);
      saveState({
        account: input.account,
        userId,
        value: input.value,
        level,
        levelSince: levelChanged ? input.now : current.levelSince,
        lastLevelChangeAt: levelChanged ? input.now : current.lastLevelChangeAt,
        lastInteractionAt: stored?.lastInteractionAt ?? 0,
        updatedAt: input.now,
      }, scope);
      return currentView({
        ...current,
        value: input.value,
        level,
        levelSince: levelChanged ? input.now : current.levelSince,
        lastLevelChangeAt: levelChanged ? input.now : current.lastLevelChangeAt,
        lastInteractionAt: stored && stored.lastInteractionAt > 0 ? stored.lastInteractionAt : null,
        updatedAt: input.now,
      });
    },

    recentEvents(account, userId, count) {
      const canonicalUserId = mainUserId(account, userId);
      const scope = scopeFor(account, options.getConfig());
      return scope.mode === 'independent'
        ? options.repository.recentPersonaAffinityEvents(account, canonicalUserId, scope.personaId, count)
        : options.repository.recentAffinityEvents(account, canonicalUserId, count);
    },
  };
}
