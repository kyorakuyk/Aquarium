import type { Hono } from 'hono';
import { z } from 'zod';
import { AquariumConfigSchema, type AquariumConfig } from '../config/schema.ts';
import { resolveSession } from '../config/resolve.ts';
import { parseSessionId } from '../core/sessions.ts';
import {
  buildActivityResponse,
  localStartOfDays,
  type ActivityCalendarResponse,
  type ActivityDistributionResponse,
  type ActivityView,
} from '../core/activity/stats.ts';
import type { ProfileActivityService } from '../core/activity/service.ts';
import type { StoreRepository } from '../store/repository.ts';

const suggestionBodySchema = z.object({
  sessionId: z.string().min(1),
  windowKey: z.string().min(1),
}).strict();

export interface ActivityRouteOptions {
  getConfig: () => AquariumConfig;
  saveConfig: (config: AquariumConfig) => void | Promise<void>;
  repository: StoreRepository;
  profileActivity: ProfileActivityService;
  now: () => number;
  serializeConfigWrite: <T>(task: () => Promise<T>) => Promise<T>;
}

function groupSessionKey(sessionId: string, config: AquariumConfig) {
  const key = parseSessionId(sessionId);
  if (!key || key.kind !== 'group' || !config.accounts.some((account) => account.uin === key.account)) {
    return undefined;
  }
  return key;
}

function parseSuggestionBody(body: unknown): z.infer<typeof suggestionBodySchema> | undefined {
  const result = suggestionBodySchema.safeParse(body);
  return result.success ? result.data : undefined;
}

export function registerActivityRoutes(app: Hono, options: ActivityRouteOptions): void {
  app.get('/api/activity', (context) => {
    const sessionId = context.req.query('sessionId');
    if (!sessionId || !groupSessionKey(sessionId, options.getConfig())) {
      return context.json({ error: 'Invalid group session' }, 400);
    }
    const rawView = context.req.query('view') ?? 'hour';
    if (!['hour', 'week', 'month', 'year'].includes(rawView)) {
      return context.json({ error: 'Invalid activity view' }, 400);
    }
    const view = rawView as ActivityView;
    const rawUserId = context.req.query('userId');
    let userId: number | undefined;
    if (rawUserId !== undefined) {
      userId = Number(rawUserId);
      if (!Number.isSafeInteger(userId) || userId <= 0) {
        return context.json({ error: 'Invalid userId' }, 400);
      }
    }
    const now = options.now();
    if (!Number.isFinite(now)) return context.json({ error: 'Invalid activity time' }, 500);
    const from = localStartOfDays(now, view === 'year' ? 365 : 90);
    const messages = options.repository.messagesInRange(sessionId, from, now);
    const activity = buildActivityResponse(messages, now, view, userId);
    if (view === 'hour' && userId === undefined) {
      return context.json({
        ...activity,
        suggestion: options.profileActivity.suggestionForSession(sessionId, now),
      });
    }
    return context.json(activity);
  });

  app.post('/api/activity/suggestion/dismiss', async (context) => {
    let rawBody: unknown;
    try { rawBody = await context.req.json(); } catch { return context.json({ error: 'Invalid JSON' }, 400); }
    const body = parseSuggestionBody(rawBody);
    if (!body || !groupSessionKey(body.sessionId, options.getConfig())) {
      return context.json({ error: 'Invalid activity suggestion' }, 400);
    }
    if (!options.profileActivity.dismissSuggestion(body.sessionId, body.windowKey, options.now())) {
      return context.json({ error: 'Activity suggestion is no longer current' }, 409);
    }
    return context.json({ dismissed: true, windowKey: body.windowKey });
  });

  app.post('/api/activity/suggestion/apply', async (context) => {
    let rawBody: unknown;
    try { rawBody = await context.req.json(); } catch { return context.json({ error: 'Invalid JSON' }, 400); }
    const body = parseSuggestionBody(rawBody);
    if (!body) return context.json({ error: 'Invalid activity suggestion' }, 400);

    return options.serializeConfigWrite(async () => {
      const config = options.getConfig();
      const key = groupSessionKey(body.sessionId, config);
      if (!key) return context.json({ error: 'Invalid group session' }, 400);
      const suggestion = options.profileActivity.suggestionForSession(body.sessionId, options.now());
      if (!suggestion || suggestion.windowKey !== body.windowKey) {
        return context.json({ error: 'Activity suggestion is no longer current' }, 409);
      }
      const effective = resolveSession(config, key);
      // resolveMode uses first-match precedence; put the accepted window before any overlapping inactive entry.
      const modeSchedule = [
        { from: suggestion.from, to: suggestion.to, mode: 'active' as const },
        ...effective.modeSchedule,
      ];
      const nextConfig = AquariumConfigSchema.parse({
        ...config,
        sessions: {
          ...config.sessions,
          [body.sessionId]: { ...(config.sessions[body.sessionId] ?? {}), modeSchedule },
        },
      });
      await options.saveConfig(nextConfig);
      return context.json({
        sessionId: body.sessionId,
        added: { from: suggestion.from, to: suggestion.to, mode: 'active' },
        modeSchedule,
      });
    });
  });
}
