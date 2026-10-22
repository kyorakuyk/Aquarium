import { Hono } from 'hono';
import { accountUserName } from '../core/profiles/account-identity.ts';
import { parseSessionId } from '../core/conversation/sessions.ts';
import { factPromotionUnavailableReason } from '../core/impressions/tag-model.ts';
import { redactSensitiveText } from '../core/impressions/sensitive-text.ts';
import type { StoreRepository } from '../store/repository.ts';
import type { StoredTag } from '../store/affect-repo.ts';
import type { PanelAccountRuntime } from './types.ts';

interface ViewImpressionRouteOptions {
  repository: StoreRepository;
  accounts: () => PanelAccountRuntime[];
  now: () => number;
}

function requestedAccount(
  value: string,
  accounts: readonly PanelAccountRuntime[],
): { account: number } | { status: 400 | 404; error: string } {
  if (!/^[1-9]\d*$/u.test(value)) return { status: 400, error: 'Invalid account UIN' };
  const account = Number(value);
  if (!Number.isSafeInteger(account)) return { status: 400, error: 'Invalid account UIN' };
  if (!accounts.some((runtime) => runtime.adapter.account === account)) {
    return { status: 404, error: 'Account not found' };
  }
  return { account };
}

function requestedTagId(value: string): number | undefined {
  if (!/^[1-9]\d*$/u.test(value)) return undefined;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : undefined;
}

function impressionView(repository: StoreRepository, tag: StoredTag) {
  const session = parseSessionId(tag.sessionId);
  return {
    id: tag.id,
    sessionId: tag.sessionId,
    sourceKind: session?.kind ?? null,
    sessionLabel: session?.kind === 'group'
      ? `群 ${session.peer}`
      : session?.kind === 'private' ? `私聊 ${session.peer}` : '会话',
    userId: tag.userId,
    name: tag.userId === null
      ? '群聊'
      : accountUserName(repository, tag.account, tag.sessionId, tag.userId),
    text: redactSensitiveText(tag.text),
    category: tag.category,
    kind: tag.kind,
    certain: tag.certain,
    polarity: tag.polarity,
    origin: tag.origin,
    source: tag.source,
    status: tag.status,
    locked: tag.locked,
  };
}

export function registerViewImpressionsRoutes(app: Hono, options: ViewImpressionRouteOptions): void {
  app.get('/api/accounts/:uin/view-impressions', (context) => {
    const requested = requestedAccount(context.req.param('uin'), options.accounts());
    if ('status' in requested) return context.json({ error: requested.error }, requested.status);
    const tags = options.repository.listViewTagsForAccount(requested.account)
      .map((tag) => impressionView(options.repository, tag));
    return context.json({ account: requested.account, tags });
  });

  app.post('/api/accounts/:uin/view-impressions/:id/confirm', (context) => {
    const requested = requestedAccount(context.req.param('uin'), options.accounts());
    if ('status' in requested) return context.json({ error: requested.error }, requested.status);
    const id = requestedTagId(context.req.param('id'));
    if (id === undefined) return context.json({ error: 'Invalid tag id' }, 400);
    const tag = options.repository.tagById(id);
    if (!tag || tag.account !== requested.account || tag.kind !== 'view') {
      return context.json({ error: 'View impression not found' }, 404);
    }
    if (tag.status === 'rejected' || tag.status === 'superseded') {
      return context.json({ error: '已忽略或已替代的印象不能重新确认' }, 409);
    }
    options.repository.updateTag(id, {
      origin: 'manual',
      source: 'manual',
      status: 'confirmed',
      updatedAt: options.now(),
    });
    const updated = options.repository.tagById(id);
    if (!updated) return context.json({ error: 'View impression not found' }, 404);
    return context.json(impressionView(options.repository, updated));
  });

  app.post('/api/accounts/:uin/view-impressions/:id/promote', (context) => {
    const requested = requestedAccount(context.req.param('uin'), options.accounts());
    if ('status' in requested) return context.json({ error: requested.error }, requested.status);
    const id = requestedTagId(context.req.param('id'));
    if (id === undefined) return context.json({ error: 'Invalid tag id' }, 400);
    const tag = options.repository.tagById(id);
    if (!tag || tag.account !== requested.account || tag.kind !== 'view') {
      return context.json({ error: 'View impression not found' }, 404);
    }
    if (tag.status !== 'confirmed') {
      const reason = '仅已确认的印象可提升为知识';
      return context.json({ error: reason, reason }, 409);
    }
    const source = parseSessionId(tag.sessionId);
    const reason = source
      ? factPromotionUnavailableReason(
        tag.category,
        tag.userId === null ? 'group' : 'member',
        source.kind,
      )
      : '来源会话无效，不能提升为知识';
    if (reason) return context.json({ error: reason, reason }, 422);
    options.repository.updateTag(id, { kind: 'fact', updatedAt: options.now() });
    const updated = options.repository.tagById(id);
    if (!updated) return context.json({ error: 'View impression not found' }, 404);
    return context.json(impressionView(options.repository, updated));
  });

  app.delete('/api/accounts/:uin/view-impressions/:id', (context) => {
    const requested = requestedAccount(context.req.param('uin'), options.accounts());
    if ('status' in requested) return context.json({ error: requested.error }, requested.status);
    const id = requestedTagId(context.req.param('id'));
    if (id === undefined) return context.json({ error: 'Invalid tag id' }, 400);
    const tag = options.repository.tagById(id);
    if (!tag || tag.account !== requested.account || tag.kind !== 'view') {
      return context.json({ error: 'View impression not found' }, 404);
    }
    const expected = { account: requested.account, kind: 'view' as const };
    const session = parseSessionId(tag.sessionId);
    const deleted = session?.kind === 'group'
      ? options.repository.deleteTagAndCreateVeto(id, expected)
      : options.repository.deleteTag(id, expected);
    if (!deleted) return context.json({ error: 'View impression not found' }, 404);
    return context.body(null, 204);
  });
}
