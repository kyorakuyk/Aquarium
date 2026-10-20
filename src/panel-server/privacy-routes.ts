import { Hono } from 'hono';
import { z } from 'zod';
import type { AquariumConfig } from '../config/schema.ts';
import { redactSensitiveText } from '../core/impressions/sensitive-text.ts';
import type { PrivateFactRecord } from '../store/privacy-repo.ts';
import type { StoreRepository } from '../store/repository.ts';
import type { PanelAccountRuntime } from './types.ts';

export interface PrivacyRouteOptions {
  getConfig: () => AquariumConfig;
  repository: StoreRepository;
  accounts: () => PanelAccountRuntime[];
  now?: () => number;
}

const patchSchema = z.object({
  text: z.string().optional(),
  level: z.enum(['L0', 'L1', 'L2']).optional(),
  auto: z.boolean().optional(),
}).strict().refine((patch) => (
  patch.text !== undefined || patch.level !== undefined || patch.auto === true
) && !(patch.auto === true && patch.level !== undefined));

function positiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function requestedAccount(raw: string | undefined, options: PrivacyRouteOptions): number | undefined {
  const runtimeAccounts = options.accounts().map((runtime) => runtime.adapter.account);
  const account = raw === undefined
    ? runtimeAccounts[0] ?? options.getConfig().accounts[0]?.uin
    : positiveInteger(raw);
  return account !== undefined && runtimeAccounts.includes(account) ? account : undefined;
}

function privacyFactView(fact: PrivateFactRecord) {
  const text = redactSensitiveText(fact.text);
  return {
    id: fact.id,
    text,
    textRedacted: text !== fact.text,
    keywords: fact.keywords.map(redactSensitiveText),
    level: fact.level,
    levelSource: fact.levelSource,
    mentions: fact.mentions,
    evidence: fact.evidence.map((evidence) => ({
      messageId: evidence.messageId,
      time: evidence.time,
      quote: redactSensitiveText(evidence.quote),
    })),
  };
}

function textLength(value: string): number {
  return Array.from(value).length;
}

export function registerPrivacyRoutes(app: Hono, options: PrivacyRouteOptions): void {
  const now = options.now ?? Date.now;

  app.get('/api/privacy/:userId', (context) => {
    const userId = positiveInteger(context.req.param('userId'));
    if (userId === undefined) return context.json({ error: 'Invalid user ID' }, 400);
    const account = requestedAccount(context.req.query('account'), options);
    if (account === undefined) return context.json({ error: 'Invalid account' }, 400);
    const name = options.repository.latestSenderNameForAccount(account, userId) ?? String(userId);
    return context.json({
      userId,
      name: redactSensitiveText(name),
      facts: options.repository.listPrivateFactsForOwner(account, userId).map(privacyFactView),
    });
  });

  app.patch('/api/privacy/facts/:id', async (context) => {
    const id = positiveInteger(context.req.param('id'));
    if (id === undefined) return context.json({ error: 'Invalid fact ID' }, 400);
    const account = requestedAccount(context.req.query('account'), options);
    if (account === undefined) return context.json({ error: 'Invalid account' }, 400);
    let body: unknown;
    try { body = await context.req.json(); } catch { return context.json({ error: 'Invalid JSON' }, 400); }
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) return context.json({ error: 'Invalid privacy fact patch' }, 400);
    if (parsed.data.text !== undefined) {
      const length = textLength(parsed.data.text);
      if (length < 4 || length > 40) return context.json({ error: 'Fact text must be 4–40 characters' }, 400);
    }

    const current = options.repository.privateFactById(id);
    if (!current || current.account !== account || current.status !== 'active') {
      return context.json({ error: 'Private fact not found' }, 404);
    }
    const updated = options.repository.updatePrivateFactControls({
      account,
      ownerId: current.ownerId,
      id,
      ...(parsed.data.text === undefined ? {} : { text: parsed.data.text }),
      ...(parsed.data.level === undefined ? {} : { level: parsed.data.level }),
      ...(parsed.data.auto === undefined ? {} : { auto: parsed.data.auto }),
      promoteMentions: options.getConfig().privacy.promoteMentions,
      updatedAt: now(),
    });
    if (!updated) return context.json({ error: 'Private fact not found' }, 404);
    return context.json({ fact: privacyFactView(updated) });
  });

  app.delete('/api/privacy/facts/:id', (context) => {
    const id = positiveInteger(context.req.param('id'));
    if (id === undefined) return context.json({ error: 'Invalid fact ID' }, 400);
    const account = requestedAccount(context.req.query('account'), options);
    if (account === undefined) return context.json({ error: 'Invalid account' }, 400);
    const current = options.repository.privateFactById(id);
    if (!current || current.account !== account || current.status !== 'active') {
      return context.json({ error: 'Private fact not found' }, 404);
    }
    options.repository.markPrivateFactDeleted(id, now());
    const deleted = options.repository.privateFactById(id);
    if (!deleted || deleted.account !== account || deleted.status !== 'deleted') {
      return context.json({ error: 'Private fact could not be deleted' }, 500);
    }
    return context.json({ id, status: 'deleted' as const });
  });
}
