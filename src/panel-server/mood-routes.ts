import { Hono } from 'hono';
import type { AquariumConfig } from '../config/schema.ts';
import { nextBand, nextReserveBand, type EnergySource } from '../core/mood/core.ts';
import { resolveMoodState } from '../core/mood/state.ts';
import { buildMoodSeriesPoints, distanceToNextBand } from '../core/mood/series.ts';
import { sleepEnergy, sleepPlan, type SleepWakeState } from '../core/sleep/index.ts';
import { redactSensitiveText } from '../core/impressions/sensitive-text.ts';
import type { MoodBand, StoredMoodEvent } from '../store/affect-repo.ts';
import type { StoreRepository } from '../store/repository.ts';
import type { PersonaEnergyMultipliers } from '../persona/energy.ts';
import type { PanelAccountRuntime } from './types.ts';

export interface MoodRouteOptions {
  getConfig: () => AquariumConfig;
  getEnergySource?: (account: number) => EnergySource;
  getEnergyMultipliers?: (account: number) => PersonaEnergyMultipliers;
  repository: StoreRepository;
  accounts: () => PanelAccountRuntime[];
  sleepWakeState?: SleepWakeState;
  now?: () => number;
}

type InjectedAffectBlocks = { mood?: string; reserve?: string; float?: string; affinity?: string };

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function injectedAffectBlocks(value: unknown): InjectedAffectBlocks | undefined {
  const source = objectRecord(value);
  if (!source) return undefined;
  const blocks: InjectedAffectBlocks = {};
  for (const key of ['mood', 'reserve', 'float', 'affinity'] as const) {
    const block = source[key];
    if (typeof block === 'string') blocks[key] = block;
  }
  return Object.keys(blocks).length > 0 ? blocks : undefined;
}

function contextTraceAffectBlocks(trace: readonly unknown[] | undefined): InjectedAffectBlocks | undefined {
  if (!trace) return undefined;
  for (const entry of trace) {
    const row = objectRecord(entry);
    if (row?.step !== 'context') continue;
    const detail = objectRecord(row.detail);
    const blocks = injectedAffectBlocks(detail?.injectedAffectBlocks);
    if (blocks) return blocks;
  }
  return undefined;
}

function moodBandChanges(events: readonly StoredMoodEvent[], from: number, to: number) {
  return events
    .filter((event) => event.source === 'band'
      && event.time >= from && event.time <= to
      && event.bandBefore !== null && event.bandAfter !== null
      && event.bandBefore !== event.bandAfter)
    .map((event) => ({ time: event.time, from: event.bandBefore as MoodBand, to: event.bandAfter as MoodBand }));
}

export function registerMoodRoutes(app: Hono, options: MoodRouteOptions): void {
  const now = options.now ?? Date.now;

  function primaryAccount(): number {
    return options.accounts()[0]?.adapter.account ?? options.getConfig().accounts[0]?.uin ?? 0;
  }

  function requestedAccount(raw: string | undefined): number | null {
    if (raw === undefined) return primaryAccount();
    if (!/^[1-9]\d*$/u.test(raw)) return null;
    const account = Number(raw);
    if (!Number.isSafeInteger(account) || !options.getConfig().accounts.some((entry) => entry.uin === account)) return null;
    return account;
  }

  function currentMoodState(account: number, at: number) {
    const config = options.getConfig();
    const source = options.getEnergySource?.(account) ?? 'mixed';
    const energyMultipliers = options.getEnergyMultipliers?.(account);
    const stored = options.repository.getMoodState(account);
    const resolvedAt = Math.max(at, stored?.updatedAt ?? at);
    const historyFrom = stored ? stored.updatedAt - 15 * 60_000 : resolvedAt - 15 * 60_000;
    const resolved = resolveMoodState({
      stored,
      at,
      settings: config.mood,
      energySource: source,
      energyMultipliers,
      appraisalEvents: stored ? options.repository.moodEventsSince(account, historyFrom) : [],
      replyTimes: stored ? options.repository.replyTimesForAccount(account, historyFrom, resolvedAt) : [],
    });
    const band = nextBand(resolved, resolved.valence, at, 'decay');
    const reserveBand = nextReserveBand({
      band: resolved.reserveBand,
      bandSince: resolved.reserveBandSince,
      lastBandChangeAt: resolved.reserveLastChangeAt,
    }, resolved.reserve, at, 'decay');
    return {
      ...resolved,
      band,
      bandSince: band === resolved.band ? resolved.bandSince : at,
      lastBandChangeAt: band === resolved.band ? resolved.lastBandChangeAt : at,
      reserveBand,
      reserveBandSince: reserveBand === resolved.reserveBand ? resolved.reserveBandSince : at,
      reserveLastChangeAt: reserveBand === resolved.reserveBand ? resolved.reserveLastChangeAt : at,
      energySource: source,
    };
  }

  app.get('/api/mood', (context) => {
    const at = now();
    const account = requestedAccount(context.req.query('account'));
    if (account === null) return context.json({ error: 'Invalid mood account' }, 400);
    const stored = options.repository.getMoodState(account);
    const state = currentMoodState(account, at);
    return context.json({
      account,
      valence: state.valence,
      arousal: state.arousal,
      band: state.band,
      bandSince: stored ? state.bandSince : null,
      reserve: state.reserve,
      reserveBand: state.reserveBand,
      reserveBandSince: stored ? state.reserveBandSince : null,
      energySource: state.energySource,
      events: options.repository.recentMoodEvents(account, 20),
    });
  });

  app.get('/api/mood/series', (context) => {
    const rawHours = context.req.query('hours');
    const hours = rawHours === undefined ? 24 : Number(rawHours);
    if (!Number.isSafeInteger(hours) || hours < 1 || hours > 168) {
      return context.json({ error: 'Invalid mood series range' }, 400);
    }

    const config = options.getConfig();
    const at = now();
    const from = at - hours * 60 * 60_000;
    const account = primaryAccount();
    const energySource = options.getEnergySource?.(account) ?? 'mixed';
    const energyMultipliers = options.getEnergyMultipliers?.(account);
    const previous = options.repository.latestMoodEventAtOrBefore(account, from);
    const historyFrom = Math.min(previous?.time ?? from, from) - 15 * 60_000;
    const events = options.repository.moodEventsSince(account, historyFrom);
    const replyTimes = options.repository.replyTimesForAccount(account, historyFrom, at);
    const points = buildMoodSeriesPoints({
      from,
      to: at,
      surfaceHalfLifeMin: config.mood.surfaceHalfLifeMin,
      arousalHalfLifeMin: config.mood.arousalHalfLifeMin,
      energySource,
      energyMultipliers,
      baseline: config.mood.baseline,
      initialReserve: config.mood.reserve.initial,
      ...(previous ? { previous } : {}),
      events,
      replyTimes,
    });

    const stored = options.repository.getMoodState(account);
    const current = currentMoodState(account, at);
    const { valence, arousal, reserve, band } = current;
    const projectedBandChange = stored !== undefined && band !== stored.band;
    const bandSince = stored ? projectedBandChange ? at : current.bandSince : null;
    const lastBandChangeAt = stored ? projectedBandChange ? at : current.lastBandChangeAt : null;
    const distance = distanceToNextBand({ band, valence, now: at, lastBandChangeAt });

    const energyAt = (time: number, includeWakeOverride: boolean) => {
      if (!config.sleep.enabled) return { value: 1, status: 'awake' as const };
      const plan = sleepPlan(time, config.sleep.bedtime, config.sleep.wake);
      const woken = includeWakeOverride && plan.asleep && (options.sleepWakeState?.isAwake(at) ?? false);
      if (plan.asleep && !woken) return { value: null, status: 'asleep' as const };
      return {
        value: sleepEnergy(
          time,
          plan.wakeAt,
          plan.bedAt,
          options.repository.replyCountLastHourForAccount(account, time),
          true,
        ),
        status: woken ? 'woken' as const : 'awake' as const,
      };
    };
    const currentEnergy = energyAt(at, true);
    const energyPoints = Array.from({ length: 7 }, (_, index) => {
      const time = Math.round(from + (at - from) * index / 6);
      return { time, value: energyAt(time, index === 6).value };
    });

    const latestDecision = options.repository.latestReplyDecision();
    const decisionDetail = objectRecord(latestDecision?.detail);
    const fallbackBlocks = injectedAffectBlocks(decisionDetail?.injectedAffectBlocks);
    const trace = latestDecision
      ? options.repository.pipelineTraceFor(latestDecision.sessionId, latestDecision.messageId)
      : undefined;
    const tracedBlocks = contextTraceAffectBlocks(trace?.trace);
    const latestBlocks = { ...fallbackBlocks, ...tracedBlocks };
    const latestReply = latestDecision ? {
      id: latestDecision.id,
      blocks: {
        mood: latestBlocks.mood === undefined ? null : redactSensitiveText(latestBlocks.mood),
        reserve: latestBlocks.reserve === undefined ? null : redactSensitiveText(latestBlocks.reserve),
        float: latestBlocks.float === undefined ? null : redactSensitiveText(latestBlocks.float),
        affinity: latestBlocks.affinity === undefined ? null : redactSensitiveText(latestBlocks.affinity),
      },
    } : null;

    return context.json({
      from,
      to: at,
      points,
      current: {
        valence,
        arousal,
        reserve,
        reserveBand: current.reserveBand,
        reserveBandSince: stored ? current.reserveBandSince : null,
        energySource,
        band,
        bandSince,
        distanceToNextBand: distance,
      },
      bandChanges: moodBandChanges(events, from, at),
      energy: { ...currentEnergy, points: energyPoints },
      latestReply,
    });
  });
}
