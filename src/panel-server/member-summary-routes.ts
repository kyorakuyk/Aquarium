import type { Hono } from 'hono';
import { z } from 'zod';
import type { AquariumConfig } from '../config/schema.ts';
import { redactSensitiveText } from '../core/impressions/sensitive-text.ts';
import { parseSessionId } from '../core/conversation/sessions.ts';
import type { MemberSummaryRepository } from '../store/member-summary-repo.ts';
import type { StoreRepository } from '../store/repository.ts';

const summaryWriteSchema = z.object({ text: z.string() }).strict();

export interface MemberSummaryRouteOptions {
  getConfig: () => AquariumConfig;
  repository: StoreRepository;
  summaries: MemberSummaryRepository;
  now: () => number;
}

function scope(options: MemberSummaryRouteOptions, sessionId: string, rawUserId: string) {
  const key = parseSessionId(sessionId);
  const userId = Number(rawUserId);
  if (!key || key.kind !== 'group'
    || !options.getConfig().accounts.some((account) => account.uin === key.account)
    || !Number.isSafeInteger(userId) || userId <= 0) return undefined;
  const memberExists = options.repository.listTagsForSession(key.account, sessionId)
    .some((tag) => tag.userId === userId);
  return memberExists ? { account: key.account, userId, sessionId } : undefined;
}

export function registerMemberSummaryRoutes(app: Hono, options: MemberSummaryRouteOptions): void {
  app.get('/api/member-summaries/:sessionId/:userId', (context) => {
    const params = scope(options, context.req.param('sessionId'), context.req.param('userId'));
    if (!params) return context.json({ error: 'Member summary target not found' }, 404);
    const summary = options.summaries.get(params.account, params.userId);
    return context.json(summary ? { ...summary, text: redactSensitiveText(summary.text) } : null);
  });

  app.put('/api/member-summaries/:sessionId/:userId', async (context) => {
    const params = scope(options, context.req.param('sessionId'), context.req.param('userId'));
    if (!params) return context.json({ error: 'Member summary target not found' }, 404);

    let rawBody: unknown;
    try { rawBody = await context.req.json(); } catch { return context.json({ error: 'Invalid JSON' }, 400); }
    const parsed = summaryWriteSchema.safeParse(rawBody);
    if (!parsed.success) return context.json({ error: 'Invalid member summary' }, 400);
    const text = parsed.data.text.trim();
    if (!text || Array.from(text).length > 50 || /[\r\n]/u.test(text)
      || redactSensitiveText(text) !== text) {
      return context.json({ error: 'Member summary must be a single line of up to 50 characters' }, 400);
    }
    const updatedAt = options.now();
    if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) {
      return context.json({ error: 'Invalid member summary time' }, 500);
    }
    options.summaries.saveManual({
      account: params.account,
      userId: params.userId,
      text,
      updatedAt,
    });
    const saved = options.summaries.get(params.account, params.userId);
    return saved
      ? context.json({ ...saved, text: redactSensitiveText(saved.text) })
      : context.json({ error: 'Member summary save failed' }, 500);
  });
}
