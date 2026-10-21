import type { Hono } from 'hono';
import { z } from 'zod';
import type { AquariumConfig } from '../config/schema.ts';
import { parseSessionId } from '../core/conversation/sessions.ts';
import { redactSensitiveText } from '../core/impressions/sensitive-text.ts';
import type { StoreRepository } from '../store/repository.ts';

const summarySchema = z.object({ text: z.string() }).strict();

export interface GroupSummaryRouteOptions {
  getConfig: () => AquariumConfig;
  repository: StoreRepository;
  now: () => number;
}

function sessionKey(options: GroupSummaryRouteOptions, sessionId: string) {
  const key = parseSessionId(sessionId);
  if (!key || key.kind !== 'group'
    || !options.getConfig().accounts.some((account) => account.uin === key.account)) return undefined;
  return key;
}

export function registerGroupSummaryRoutes(app: Hono, options: GroupSummaryRouteOptions): void {
  app.get('/api/group-summaries/:sessionId', (context) => {
    const key = sessionKey(options, context.req.param('sessionId'));
    if (!key) return context.json({ error: 'Group summary target not found' }, 404);
    const summary = options.repository.getGroupSummary(key.account, context.req.param('sessionId'));
    return context.json(summary ? { ...summary, text: redactSensitiveText(summary.text) } : null);
  });

  app.put('/api/group-summaries/:sessionId', async (context) => {
    const id = context.req.param('sessionId');
    const key = sessionKey(options, id);
    if (!key) return context.json({ error: 'Group summary target not found' }, 404);
    let rawBody: unknown;
    try { rawBody = await context.req.json(); } catch { return context.json({ error: 'Invalid JSON' }, 400); }
    const parsed = summarySchema.safeParse(rawBody);
    if (!parsed.success) return context.json({ error: 'Invalid group summary' }, 400);
    const text = parsed.data.text.trim();
    if (!text || Array.from(text).length > 50 || /[\r\n]/u.test(text)
      || redactSensitiveText(text) !== text) {
      return context.json({ error: 'Group summary must be a single line of up to 50 characters' }, 400);
    }
    const updatedAt = options.now();
    if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) {
      return context.json({ error: 'Invalid group summary time' }, 500);
    }
    options.repository.saveManualGroupSummary({
      account: key.account,
      sessionId: id,
      text,
      updatedAt,
    });
    const saved = options.repository.getGroupSummary(key.account, id);
    return saved
      ? context.json({ ...saved, text: redactSensitiveText(saved.text) })
      : context.json({ error: 'Group summary save failed' }, 500);
  });
}
