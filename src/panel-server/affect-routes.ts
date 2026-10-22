import { Hono } from 'hono';
import { z } from 'zod';
import type { AquariumConfig } from '../config/schema.ts';
import { parseSessionId } from '../core/conversation/sessions.ts';
import { bandOf, decayValue, nextBand } from '../core/mood/core.ts';
import { buildMoodSeriesPoints, distanceToNextBand } from '../core/mood/series.ts';
import { sleepEnergy, sleepPlan, type SleepWakeState } from '../core/sleep/index.ts';
import { createQqProfileService } from '../core/profiles/qq-profile-service.ts';
import { summarizeQqMemberComposition } from '../core/profiles/qq-profile-view.ts';
import { normalizeTagText, tagActivation, tagHalfLifeMs } from '../core/impressions/tags.ts';
import { TAG_TEXT_MAX, TAG_TEXT_MIN } from '../core/impressions/service.ts';
import { buildMemberTagPrompt } from '../core/impressions/member-tags.ts';
import { relationPromptLines } from '../core/impressions/prompt-blocks.ts';
import { accountUserName } from '../core/profiles/account-identity.ts';
import { decide } from '../core/privacy/policy.ts';
import { promptTemplateStore } from '../core/prompt/templates.ts';
import { redactSensitiveText } from '../core/impressions/sensitive-text.ts';
import { createAffinityService } from '../core/affinity/service.ts';
import type { MoodBand, StoredMoodEvent, StoredTag } from '../store/affect-repo.ts';
import type { StoreRepository } from '../store/repository.ts';
import type { PanelAccountRuntime } from './types.ts';
import type { HistoryImportService } from '../core/impressions/history-import.ts';
import {
  isTagCategoryForScope,
  normalizeTagSubjectPath,
  TAG_CATEGORY_KEYS,
} from '../core/impressions/tag-model.ts';
import { buildImpressionsLayoutContext } from './impressions-layout-context.ts';

export interface AffectRouteOptions {
  getConfig: () => AquariumConfig;
  repository: StoreRepository;
  accounts: () => PanelAccountRuntime[];
  historyImports?: HistoryImportService;
  sleepWakeState?: SleepWakeState;
  now?: () => number;
}

const manualTagSchema = z.object({
  sessionId: z.string().min(1),
  userId: z.number().int().positive().nullable(),
  text: z.string(),
  category: z.enum([...TAG_CATEGORY_KEYS, 'misc']).optional(),
  subject: z.string().nullable().optional(),
  polarity: z.enum(['like', 'dislike']).nullable().optional(),
}).strict();

const tagPatchSchema = z.object({
  text: z.string().optional(),
  status: z.enum(['confirmed', 'rejected', 'candidate']).optional(),
  locked: z.boolean().optional(),
}).strict();

const affinityPatchSchema = z.object({ value: z.number().int().min(0).max(100) }).strict();
const historyImportSchema = z.object({
  target: z.union([z.literal(200), z.literal(500), z.literal(1_000), z.literal(2_000)]),
  mode: z.enum(['incremental', 'full']).default('incremental'),
}).strict();

function parseJsonBody<T>(body: unknown, schema: z.ZodType<T>): T | undefined {
  const result = schema.safeParse(body);
  return result.success ? result.data : undefined;
}

function textLength(text: string): number {
  return Array.from(text).length;
}

function tagView(tag: StoredTag, at: number) {
  return {
    id: tag.id,
    text: redactSensitiveText(tag.text),
    category: tag.category,
    kind: tag.kind,
    subject: tag.subject === null ? null : redactSensitiveText(tag.subject),
    polarity: tag.polarity,
    origin: tag.origin,
    locked: tag.locked,
    fadeAt: tag.category === 'recent' && tag.source === 'auto'
      ? tag.lastSeen + (tagHalfLifeMs(tag) ?? 0) * 2
      : null,
    status: tag.status,
    source: tag.source,
    samples: tag.samples,
    activation: tagActivation(tag, at),
    evidence: tag.evidence.map((item) => item.kind === 'signature'
      ? { kind: item.kind, text: redactSensitiveText(item.text), fetchedAt: item.fetchedAt }
      : { ...item, quote: redactSensitiveText(item.quote) }),
    firstSeen: tag.firstSeen,
    lastSeen: tag.lastSeen,
  };
}

type InjectedAffectBlocks = { mood?: string; float?: string; affinity?: string };

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function injectedAffectBlocks(value: unknown): InjectedAffectBlocks | undefined {
  const source = objectRecord(value);
  if (!source) return undefined;
  const blocks: InjectedAffectBlocks = {};
  for (const key of ['mood', 'float', 'affinity'] as const) {
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

export function registerAffectRoutes(app: Hono, options: AffectRouteOptions): void {
  const now = options.now ?? Date.now;
  const affinityService = createAffinityService({ repository: options.repository, getConfig: options.getConfig });
  const qqProfiles = createQqProfileService({ repository: options.repository, now });
  const historyImports = options.historyImports;

  function primaryAccount(): number {
    return options.accounts()[0]?.adapter.account ?? options.getConfig().accounts[0]?.uin ?? 0;
  }

  function requestedAccount(rawAccount: string | undefined): number | undefined {
    if (rawAccount === undefined) return primaryAccount();
    const account = Number(rawAccount);
    return Number.isSafeInteger(account)
      && options.accounts().some((runtime) => runtime.adapter.account === account)
      ? account
      : undefined;
  }

  function affinityView(account: number, userId: number, at: number) {
    return {
      ...affinityService.getCurrent(account, userId, at),
      name: options.repository.latestSenderNameForAccount(account, userId) ?? String(userId),
    };
  }

  app.get('/api/mood', (context) => {
    const config = options.getConfig();
    const at = now();
    const account = primaryAccount();
    const state = options.repository.getMoodState(account);
    const baseline = config.mood.baseline;
    return context.json({
      valence: state
        ? decayValue(state.valence, baseline.valence, at - state.updatedAt, config.mood.halfLifeMin)
        : baseline.valence,
      arousal: state
        ? decayValue(state.arousal, baseline.arousal, at - state.updatedAt, config.mood.halfLifeMin)
        : baseline.arousal,
      band: state?.band ?? bandOf(baseline.valence),
      bandSince: state ? state.bandSince : null,
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
    const events = options.repository.moodEventsSince(account, from);
    const previous = options.repository.latestMoodEventAtOrBefore(account, from);
    const points = buildMoodSeriesPoints({
      from,
      to: at,
      halfLifeMin: config.mood.halfLifeMin,
      baseline: config.mood.baseline,
      ...(previous ? { previous } : {}),
      events,
    });

    const state = options.repository.getMoodState(account);
    const valence = state
      ? decayValue(state.valence, config.mood.baseline.valence, at - state.updatedAt, config.mood.halfLifeMin)
      : config.mood.baseline.valence;
    const arousal = state
      ? decayValue(state.arousal, config.mood.baseline.arousal, at - state.updatedAt, config.mood.halfLifeMin)
      : config.mood.baseline.arousal;
    const band = state ? nextBand(state, valence, at, 'decay') : bandOf(config.mood.baseline.valence);
    const projectedBandChange = state !== undefined && band !== state.band;
    const bandSince = state ? projectedBandChange ? at : state.bandSince : null;
    const lastBandChangeAt = state ? projectedBandChange ? at : state.lastBandChangeAt : null;
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
        band,
        bandSince,
        distanceToNextBand: distance,
      },
      bandChanges: moodBandChanges(events, from, at),
      energy: { ...currentEnergy, points: energyPoints },
      latestReply,
    });
  });

  app.get('/api/affinity', (context) => {
    const account = requestedAccount(context.req.query('account'));
    if (account === undefined) return context.json({ error: 'Invalid account' }, 400);
    const at = now();
    const people = affinityService.listCurrent(account, at).map((person) => ({
      ...person,
      name: options.repository.latestSenderNameForAccount(account, person.userId) ?? String(person.userId),
    }));
    return context.json(people);
  });

  app.get('/api/affinity/:userId', (context) => {
    const userId = Number(context.req.param('userId'));
    if (!Number.isSafeInteger(userId) || userId <= 0) return context.json({ error: 'Invalid user' }, 400);
    const account = requestedAccount(context.req.query('account'));
    if (account === undefined) return context.json({ error: 'Invalid account' }, 400);
    return context.json({
      ...affinityView(account, userId, now()),
      events: options.repository.recentAffinityEvents(account, userId, 20).map((event) => ({
        ...event,
        reason: redactSensitiveText(event.reason),
      })),
    });
  });

  app.patch('/api/affinity/:userId', async (context) => {
    const userId = Number(context.req.param('userId'));
    if (!Number.isSafeInteger(userId) || userId <= 0) return context.json({ error: 'Invalid user' }, 400);
    const account = requestedAccount(context.req.query('account'));
    if (account === undefined) return context.json({ error: 'Invalid account' }, 400);
    let rawBody: unknown;
    try { rawBody = await context.req.json(); } catch { return context.json({ error: 'Invalid JSON' }, 400); }
    const body = parseJsonBody(rawBody, affinityPatchSchema);
    if (!body) return context.json({ error: 'Invalid affinity value' }, 400);

    const current = affinityService.setManual({ account, userId, value: body.value, now: now() });
    return context.json({
      ...current,
      name: options.repository.latestSenderNameForAccount(account, userId) ?? String(userId),
    });
  });

  app.get('/api/impressions/:sessionId', async (context) => {
    const id = context.req.param('sessionId');
    const key = parseSessionId(id);
    if (!key) return context.json({ error: 'Invalid session' }, 400);

    const at = now();
    const runtime = key.kind === 'group'
      ? options.accounts().find((candidate) => candidate.adapter.account === key.account)
      : undefined;
    const qqProfile = key.kind === 'group'
      ? await qqProfiles.readGroup({
        account: key.account,
        groupId: key.peer,
        ...(runtime?.getStatus() === 'online' ? { adapter: runtime.adapter } : {}),
      })
      : undefined;
    const qqMemberProfiles = new Map((qqProfile?.members ?? []).map((profile) => [profile.userId, profile]));
    const qqMembers = (qqProfile?.members ?? []).map((profile) => ({
      userId: profile.userId,
      name: profile.nickname?.trim() || profile.card?.trim() || String(profile.userId),
      ...(profile.card === undefined ? {} : { card: redactSensitiveText(profile.card) }),
    }));
    const qqGroupProfile = qqProfile ? {
      ...qqProfile.profile,
      groupInfo: qqProfile.profile.groupInfo === null ? null : {
        ...qqProfile.profile.groupInfo,
        ...(qqProfile.profile.groupInfo.groupDescription === undefined
          ? {}
          : { groupDescription: redactSensitiveText(qqProfile.profile.groupInfo.groupDescription) }),
      },
      latestNotice: qqProfile.profile.latestNotice === null
        ? null
        : redactSensitiveText(qqProfile.profile.latestNotice),
      composition: qqProfile.membersAvailable ? summarizeQqMemberComposition(qqProfile.members, at) : null,
      fetchedAt: qqProfile.fetchedAt,
    } : null;
    const tags = options.repository.listTagsForSession(key.account, id);
    const groupTags = tags.filter((tag) => tag.userId === null).map((tag) => tagView(tag, at));
    const layout = buildImpressionsLayoutContext({
      repository: options.repository,
      session: key,
      sessionId: id,
      now: at,
      tags,
      rosterUserIds: (qqProfile?.members ?? []).map((profile) => profile.userId),
      template: promptTemplateStore.get().replySystem,
    });
    const { groupTagsText, groupScheduleDrop, messageActivity, memberIds, memberScheduleDrops } = layout;
    const members = memberIds.map((userId) => {
      const name = accountUserName(options.repository, key.account, id, userId);
      const memberTags = tags.filter((tag) => tag.userId !== null
        && options.repository.mainUserIdFor(key.account, tag.userId) === userId);
      const kind = options.repository.getAccountKind(key.account, userId)?.kind ?? null;
      const relations = options.repository.listRelationsForUser(key.account, userId).flatMap((relation) => {
        const currentIsMain = relation.aUserId === userId;
        const rawOtherUserId = currentIsMain ? relation.bUserId : relation.aUserId;
        const otherUserId = relation.type === 'alt'
          ? rawOtherUserId
          : options.repository.mainUserIdFor(key.account, rawOtherUserId);
        if (relation.type !== 'alt' && otherUserId === userId) return [];
        const otherName = accountUserName(options.repository, key.account, id, otherUserId);
        return [{
          id: relation.id,
          type: relation.type,
          label: relation.label === null ? null : redactSensitiveText(relation.label),
          locked: relation.locked,
          otherUserId,
          otherName,
          currentRole: relation.type === 'alt' ? (currentIsMain ? 'main' as const : 'alt' as const) : null,
        }];
      });
      const memberAllowed = userId !== key.account && decide({
        info: { origin: 'group', sessionId: id, ownerId: userId },
        target: { kind: 'group', sessionId: id },
        purpose: 'prompt',
      }) === 'allow';
      const memberPrompt = memberAllowed
        ? buildMemberTagPrompt(
          memberTags.filter((tag) => tag.kind === 'fact'),
          at,
          {
            ...qqProfiles.getCachedMemberProfile(key.account, key.peer, userId),
            relationships: relationPromptLines(options.repository, key.account, id, userId),
          },
        )
        : { text: '', dropped: 0, profileText: '' };
      const hasMemberContext = memberPrompt.text.length > 0 || memberPrompt.profileText.length > 0 || kind === 'bot';
      const memberTagsText = hasMemberContext
        ? promptTemplateStore.get().replySystem.memberTags
          .replaceAll('{{name}}', JSON.stringify(kind === 'bot' ? `${name}（bot）` : name))
          .replaceAll('{{profile}}', memberPrompt.profileText)
          .replaceAll('{{tags}}', memberPrompt.text || '暂无已确认标签')
        : null;
      return {
        userId,
        name,
        messageCount: messageActivity.get(userId)?.messageCount ?? 0,
        lastMessageTime: messageActivity.get(userId)?.lastMessageTime ?? null,
        scheduleDrop: memberScheduleDrops.get(userId) ?? null,
        kind,
        relations,
        affinity: affinityService.getCurrent(key.account, userId, at),
        qqProfile: (() => {
          const profile = qqMemberProfiles.get(userId);
          if (!profile) return null;
          return {
            card: profile.card,
            role: profile.role,
            ...(profile.title === undefined ? {} : { title: redactSensitiveText(profile.title) }),
            sex: profile.sex,
            age: profile.age,
            qage: profile.qage,
            level: profile.level,
            joinTime: profile.joinTime,
            lastSentTime: profile.lastSentTime,
            isRobot: profile.isRobot,
          };
        })(),
        tags: memberTags.map((tag) => tagView(tag, at)),
        memberTagsAllowed: memberAllowed,
        memberTagsText: memberTagsText === null ? null : redactSensitiveText(memberTagsText),
      };
    });
    const lastMessageTime = options.repository.getTagRun(key.account, id)?.lastMessageTime ?? null;
    return context.json({
      sessionId: id,
      groupTags,
      groupTagsText,
      groupScheduleDrop: groupScheduleDrop ?? null,
      members,
      lastMessageTime,
      qqGroupProfile,
      qqMembers,
    });
  });

  app.post('/api/impressions/:sessionId/refresh-qq-profile', async (context) => {
    const id = context.req.param('sessionId');
    const key = parseSessionId(id);
    if (!key || key.kind !== 'group') return context.json({ error: '仅支持群聊 QQ 资料刷新' }, 400);
    const runtime = options.accounts().find((candidate) => candidate.adapter.account === key.account);
    const result = await qqProfiles.readGroup({
      account: key.account,
      groupId: key.peer,
      force: true,
      ...(runtime?.getStatus() === 'online' ? { adapter: runtime.adapter } : {}),
    });
    return context.json({ refreshed: runtime?.getStatus() === 'online', fetchedAt: result.fetchedAt });
  });

  app.post('/api/impressions/:sessionId/import', async (context) => {
    if (!historyImports) return context.json({ error: '历史导入暂不可用' }, 503);
    const id = context.req.param('sessionId');
    const key = parseSessionId(id);
    if (!key || key.kind !== 'group') return context.json({ error: '仅支持群聊历史导入' }, 400);
    let rawBody: unknown;
    try { rawBody = await context.req.json(); } catch { return context.json({ error: 'Invalid JSON' }, 400); }
    const body = parseJsonBody(rawBody, historyImportSchema);
    if (!body) return context.json({ error: 'Invalid target' }, 400);

    const runtime = options.accounts().find((candidate) => candidate.adapter.account === key.account);
    if (!runtime) return context.json({ error: 'Unknown account' }, 404);
    if (runtime.getStatus() !== 'online') return context.json({ error: '小号不在线' }, 503);
    if (historyImports.isRunning(id)) return context.json({ error: '该群已有导入任务' }, 409);

    const job = historyImports.start({ session: key, target: body.target, mode: body.mode, adapter: runtime.adapter });
    if (!job) return context.json({ error: '该群已有印象提取任务' }, 409);
    return context.json({ id: job.id }, 202);
  });

  app.post('/api/impressions/import/:jobId/confirm', (context) => {
    if (!historyImports) return context.json({ error: '历史导入暂不可用' }, 503);
    const job = historyImports.confirm(context.req.param('jobId'));
    if (!job) return context.json({ error: '导入任务已过期、正在整理或不存在' }, 409);
    return context.json(job, job.phase === 'extracting' ? 202 : 200);
  });

  app.get('/api/impressions/import/:jobId', (context) => {
    const job = historyImports?.get(context.req.param('jobId'));
    return job ? context.json(job) : context.json({ error: 'Import job not found' }, 404);
  });

  app.post('/api/impressions/import/:jobId/cancel', (context) => {
    const job = historyImports?.cancel(context.req.param('jobId'));
    return job ? context.json(job) : context.json({ error: 'Import job not found or already finished' }, 404);
  });

  app.post('/api/tags', async (context) => {
    let rawBody: unknown;
    try { rawBody = await context.req.json(); } catch { return context.json({ error: 'Invalid JSON' }, 400); }
    const body = parseJsonBody(rawBody, manualTagSchema);
    if (!body) return context.json({ error: 'Invalid tag request' }, 400);
    const key = parseSessionId(body.sessionId);
    if (!key) return context.json({ error: 'Invalid session' }, 400);
    if (textLength(body.text) < TAG_TEXT_MIN || textLength(body.text) > TAG_TEXT_MAX) {
      return context.json({ error: 'Invalid tag text' }, 400);
    }
    const category = body.category ?? 'misc';
    const scope = body.userId === null ? 'group' : 'member';
    const subject = body.subject?.trim() ?? '';
    const hasSubjectField = body.subject !== undefined && body.subject !== null;
    const hasPolarityField = body.polarity !== undefined && body.polarity !== null;
    const subjectCategory = category === 'topic' || category === 'fandom';
    if (!isTagCategoryForScope(category, scope)
      || (!subjectCategory && (hasSubjectField || hasPolarityField))
      || (hasSubjectField && !subject)
      || (subject && !normalizeTagSubjectPath(subject))
      || (category === 'topic' && body.polarity !== undefined && body.polarity !== null)
      || textLength(subject) > 40) {
      return context.json({ error: 'Invalid tag subject or polarity' }, 400);
    }
    if (redactSensitiveText(body.text) !== body.text
      || (subject && redactSensitiveText(subject) !== subject)) {
      return context.json({ error: 'Tag contains sensitive text' }, 400);
    }

    const at = now();
    const id = options.repository.insertTag({
      account: key.account,
      sessionId: body.sessionId,
      userId: body.userId,
      text: body.text,
      norm: normalizeTagText(body.text),
      category,
      subject: subjectCategory && subject ? subject : null,
      polarity: category === 'fandom' ? body.polarity ?? null : null,
      origin: 'manual',
      locked: false,
      status: 'confirmed',
      source: 'manual',
      samples: 1,
      evidence: [],
      firstSeen: at,
      lastSeen: at,
      supersededBy: null,
      updatedAt: at,
    });
    const created = options.repository.tagById(id);
    if (!created) return context.json({ error: 'Tag insert failed' }, 500);
    return context.json(tagView(created, at));
  });

  app.patch('/api/tags/:id', async (context) => {
    const id = Number(context.req.param('id'));
    if (!Number.isSafeInteger(id) || id <= 0) return context.json({ error: 'Invalid tag id' }, 400);
    let rawBody: unknown;
    try { rawBody = await context.req.json(); } catch { return context.json({ error: 'Invalid JSON' }, 400); }
    const patch = parseJsonBody(rawBody, tagPatchSchema);
    if (!patch || (patch.text === undefined && patch.status === undefined && patch.locked === undefined)) {
      return context.json({ error: 'Invalid tag patch' }, 400);
    }
    if (patch.text !== undefined
      && (textLength(patch.text) < TAG_TEXT_MIN || textLength(patch.text) > TAG_TEXT_MAX)) {
      return context.json({ error: 'Invalid tag text' }, 400);
    }
    if (patch.text !== undefined && redactSensitiveText(patch.text) !== patch.text) {
      return context.json({ error: 'Tag contains sensitive text' }, 400);
    }
    const existing = options.repository.tagById(id);
    if (!existing) return context.json({ error: 'Tag not found' }, 404);

    options.repository.updateTag(id, {
      ...(patch.text === undefined ? {} : { text: patch.text, norm: normalizeTagText(patch.text) }),
      ...(patch.status === undefined ? {} : { status: patch.status }),
      ...(patch.locked === undefined ? {} : { locked: patch.locked }),
      updatedAt: now(),
    });
    const updated = options.repository.tagById(id);
    return context.json(tagView(updated ?? existing, now()));
  });

  app.delete('/api/tags/:id', (context) => {
    const id = Number(context.req.param('id'));
    if (!Number.isSafeInteger(id) || id <= 0) return context.json({ error: 'Invalid tag id' }, 400);
    if (!options.repository.deleteTagAndCreateVeto(id)) return context.json({ error: 'Tag not found' }, 404);
    return context.body(null, 204);
  });
}
