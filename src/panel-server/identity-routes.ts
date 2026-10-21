import type { Hono } from 'hono';
import { z } from 'zod';
import type { AquariumConfig } from '../config/schema.ts';
import { parseSessionId } from '../core/conversation/sessions.ts';
import { redactSensitiveText } from '../core/impressions/sensitive-text.ts';
import type { StoreRepository } from '../store/repository.ts';
import { ACCOUNT_KINDS, RELATION_TYPES } from '../store/identity-repo.ts';

const kindBodySchema = z.object({ kind: z.enum(ACCOUNT_KINDS).nullable() }).strict();
const relationBodySchema = z.object({
  targetUserId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  type: z.enum(RELATION_TYPES),
  currentRole: z.enum(['main', 'alt']).optional(),
  label: z.string().optional(),
}).strict();
const lockBodySchema = z.object({ locked: z.boolean() }).strict();

export interface IdentityRouteOptions {
  getConfig: () => AquariumConfig;
  repository: StoreRepository;
  now: () => number;
}

function parseJsonBody<T>(value: unknown, schema: z.ZodType<T>): T | undefined {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function positiveId(raw: string): number | undefined {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function scopedMember(options: IdentityRouteOptions, rawSessionId: string, rawUserId: string) {
  const key = parseSessionId(rawSessionId);
  const userId = positiveId(rawUserId);
  if (!key || key.kind !== 'group' || userId === undefined
    || !options.getConfig().accounts.some((account) => account.uin === key.account)) return undefined;
  const exists = options.repository.senderNameFor(rawSessionId, userId) !== undefined
    || options.repository.getQqMemberProfile(key.account, key.peer, userId) !== undefined
    || options.repository.listTagsForSession(key.account, rawSessionId).some((tag) => tag.userId === userId);
  return exists ? { account: key.account, groupId: key.peer, sessionId: rawSessionId, userId } : undefined;
}

function validRelationDetails(body: z.infer<typeof relationBodySchema>): boolean {
  if (body.type === 'alt') return body.currentRole !== undefined && body.label === undefined;
  if (body.currentRole !== undefined) return false;
  if (body.type !== 'other') return body.label === undefined;
  const label = body.label?.trim() ?? '';
  return label.length > 0 && Array.from(label).length <= 40
    && !/[\r\n]/u.test(label) && redactSensitiveText(label) === label;
}

function relationConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /constraint|关系|小号/i.test(error.message);
}

export function registerIdentityRoutes(app: Hono, options: IdentityRouteOptions): void {
  app.patch('/api/identity/:sessionId/:userId/kind', async (context) => {
    const target = scopedMember(options, context.req.param('sessionId'), context.req.param('userId'));
    if (!target) return context.json({ error: 'Identity target not found' }, 404);
    let rawBody: unknown;
    try { rawBody = await context.req.json(); } catch { return context.json({ error: 'Invalid JSON' }, 400); }
    const body = parseJsonBody(rawBody, kindBodySchema);
    if (!body) return context.json({ error: 'Invalid account kind' }, 400);
    const at = options.now();
    if (!Number.isSafeInteger(at) || at < 0) return context.json({ error: 'Invalid identity time' }, 500);
    if (body.kind === null) options.repository.deleteAccountKind(target.account, target.userId);
    else options.repository.setAccountKind(target.account, target.userId, body.kind, at);
    const saved = options.repository.getAccountKind(target.account, target.userId);
    if ((body.kind === null && saved) || (body.kind !== null && saved?.kind !== body.kind)) {
      return context.json({ error: 'Account kind read-back failed' }, 500);
    }
    return context.json({ userId: target.userId, kind: saved?.kind ?? null });
  });

  app.post('/api/identity/:sessionId/:userId/relations', async (context) => {
    const target = scopedMember(options, context.req.param('sessionId'), context.req.param('userId'));
    if (!target) return context.json({ error: 'Identity target not found' }, 404);
    let rawBody: unknown;
    try { rawBody = await context.req.json(); } catch { return context.json({ error: 'Invalid JSON' }, 400); }
    const body = parseJsonBody(rawBody, relationBodySchema);
    if (!body || !validRelationDetails(body) || body.targetUserId === target.userId) {
      return context.json({ error: 'Invalid relationship' }, 400);
    }
    const at = options.now();
    if (!Number.isSafeInteger(at) || at < 0) return context.json({ error: 'Invalid identity time' }, 500);
    try {
      if (body.type === 'alt') {
        const aUserId = body.currentRole === 'main' ? target.userId : body.targetUserId;
        const bUserId = body.currentRole === 'main' ? body.targetUserId : target.userId;
        options.repository.linkAltAccount({ account: target.account, aUserId, bUserId, createdAt: at });
      } else {
        options.repository.createRelation({
          account: target.account,
          aUserId: target.userId,
          bUserId: body.targetUserId,
          type: body.type,
          label: body.type === 'other' ? body.label!.trim() : null,
          locked: false,
          createdAt: at,
        });
      }
    } catch (error) {
      if (relationConflict(error)) return context.json({ error: 'Relationship conflicts with an existing link' }, 409);
      throw error;
    }
    const saved = options.repository.listRelationsForUser(target.account, target.userId)
      .find((relation) => relation.createdAt === at
        && relation.type === body.type
        && (relation.aUserId === body.targetUserId || relation.bUserId === body.targetUserId));
    if (!saved) return context.json({ error: 'Relationship read-back failed' }, 500);
    return context.json(saved, 201);
  });

  app.patch('/api/identity/:sessionId/:userId/relations/:relationId', async (context) => {
    const target = scopedMember(options, context.req.param('sessionId'), context.req.param('userId'));
    if (!target) return context.json({ error: 'Identity target not found' }, 404);
    const relationId = positiveId(context.req.param('relationId'));
    if (relationId === undefined) return context.json({ error: 'Invalid relation ID' }, 400);
    let rawBody: unknown;
    try { rawBody = await context.req.json(); } catch { return context.json({ error: 'Invalid JSON' }, 400); }
    const body = parseJsonBody(rawBody, lockBodySchema);
    if (!body) return context.json({ error: 'Invalid lock state' }, 400);
    if (!options.repository.listRelationsForUser(target.account, target.userId).some(({ id }) => id === relationId)) {
      return context.json({ error: 'Relationship not found' }, 404);
    }
    options.repository.updateRelationLock(target.account, relationId, body.locked);
    const saved = options.repository.listRelationsForUser(target.account, target.userId)
      .find(({ id }) => id === relationId);
    if (!saved || saved.locked !== body.locked) return context.json({ error: 'Relationship read-back failed' }, 500);
    return context.json(saved);
  });

  app.delete('/api/identity/:sessionId/:userId/relations/:relationId', (context) => {
    const target = scopedMember(options, context.req.param('sessionId'), context.req.param('userId'));
    if (!target) return context.json({ error: 'Identity target not found' }, 404);
    const relationId = positiveId(context.req.param('relationId'));
    if (relationId === undefined) return context.json({ error: 'Invalid relation ID' }, 400);
    if (!options.repository.listRelationsForUser(target.account, target.userId).some(({ id }) => id === relationId)) {
      return context.json({ error: 'Relationship not found' }, 404);
    }
    options.repository.deleteRelation(target.account, relationId);
    if (options.repository.listRelationsForUser(target.account, target.userId).some(({ id }) => id === relationId)) {
      return context.json({ error: 'Relationship deletion read-back failed' }, 500);
    }
    return context.json({ deleted: true, relationId });
  });
}
