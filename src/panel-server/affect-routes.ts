import { Hono } from 'hono';
import { z } from 'zod';
import type { AquariumConfig } from '../config/schema.ts';
import { parseSessionId } from '../core/sessions.ts';
import { bandOf, decayValue } from '../core/mood/core.ts';
import { normalizeTagText, tagActivation } from '../core/impressions/tags.ts';
import { TAG_TEXT_MAX, TAG_TEXT_MIN } from '../core/impressions/service.ts';
import type { StoredTag } from '../store/affect-repo.ts';
import type { StoreRepository } from '../store/repository.ts';
import type { PanelAccountRuntime } from './types.ts';

export interface AffectRouteOptions {
  getConfig: () => AquariumConfig;
  repository: StoreRepository;
  accounts: () => PanelAccountRuntime[];
  now?: () => number;
}

const manualTagSchema = z.object({
  sessionId: z.string().min(1),
  userId: z.number().int().positive().nullable(),
  text: z.string(),
}).strict();

const tagPatchSchema = z.object({
  text: z.string().optional(),
  status: z.enum(['confirmed', 'rejected', 'candidate']).optional(),
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
    text: tag.text,
    status: tag.status,
    source: tag.source,
    samples: tag.samples,
    activation: tagActivation(tag, at),
    evidence: tag.evidence,
    firstSeen: tag.firstSeen,
    lastSeen: tag.lastSeen,
  };
}

export function registerAffectRoutes(app: Hono, options: AffectRouteOptions): void {
  const now = options.now ?? Date.now;

  app.get('/api/mood', (context) => {
    const config = options.getConfig();
    const at = now();
    const account = options.accounts()[0]?.adapter.account ?? 0;
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

  app.get('/api/impressions/:sessionId', (context) => {
    const id = context.req.param('sessionId');
    const key = parseSessionId(id);
    if (!key) return context.json({ error: 'Invalid session' }, 400);

    const at = now();
    const tags = options.repository.listTagsForSession(key.account, id);
    const groupTags = tags.filter((tag) => tag.userId === null).map((tag) => tagView(tag, at));
    const memberIds = [...new Set(
      tags.map((tag) => tag.userId).filter((userId): userId is number => userId !== null),
    )];
    const members = memberIds.map((userId) => ({
      userId,
      name: options.repository.senderNameFor(id, userId) ?? String(userId),
      tags: tags.filter((tag) => tag.userId === userId).map((tag) => tagView(tag, at)),
    }));
    return context.json({ sessionId: id, groupTags, members });
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

    const at = now();
    const id = options.repository.insertTag({
      account: key.account,
      sessionId: body.sessionId,
      userId: body.userId,
      text: body.text,
      norm: normalizeTagText(body.text),
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
    if (!patch || (patch.text === undefined && patch.status === undefined)) {
      return context.json({ error: 'Invalid tag patch' }, 400);
    }
    if (patch.text !== undefined
      && (textLength(patch.text) < TAG_TEXT_MIN || textLength(patch.text) > TAG_TEXT_MAX)) {
      return context.json({ error: 'Invalid tag text' }, 400);
    }
    const existing = options.repository.tagById(id);
    if (!existing) return context.json({ error: 'Tag not found' }, 404);

    options.repository.updateTag(id, {
      ...(patch.text === undefined ? {} : { text: patch.text, norm: normalizeTagText(patch.text) }),
      ...(patch.status === undefined ? {} : { status: patch.status }),
      updatedAt: now(),
    });
    const updated = options.repository.tagById(id);
    return context.json(tagView(updated ?? existing, now()));
  });
}
