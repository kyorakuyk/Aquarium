import { existsSync } from 'node:fs';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { AquariumConfig } from '../config/schema.ts';
import { redactSensitiveText } from '../core/impressions/sensitive-text.ts';
import { loadPersona } from '../persona/load.ts';
import { validPersonaId, personaPath } from './persona-paths.ts';
import type { StoreRepository } from '../store/repository.ts';
import type { PersonaCounterpart } from '../persona/counterparts.ts';

const bindingBodySchema = z.object({
  userId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();

export interface PersonaCounterpartRouteOptions {
  getConfig: () => AquariumConfig;
  repository: StoreRepository;
  now: () => number;
}

function positiveId(raw: string): number | undefined {
  if (!/^[1-9]\d{0,15}$/u.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

function configuredAccounts(config: AquariumConfig): number[] {
  return [...new Set(config.accounts.map(({ uin }) => uin))];
}

function readPersonaCounterparts(root: string, id: string): PersonaCounterpart[] | undefined {
  const hasPersona = existsSync(personaPath(root, 'data/personas', id))
    || existsSync(personaPath(root, 'personas', id));
  if (!hasPersona) return undefined;
  return loadPersona(id, '', { root }).counterparts ?? [];
}

function counterpartByName(counterparts: PersonaCounterpart[], name: string): PersonaCounterpart | undefined {
  return counterparts.find((counterpart) => counterpart.name === name);
}

export function registerPersonaCounterpartRoutes(
  app: Hono,
  root: string,
  options: PersonaCounterpartRouteOptions,
): void {
  app.get('/api/personas/:id/counterparts', (context) => {
    const personaId = context.req.param('id');
    if (!validPersonaId(personaId.toLowerCase())) return context.json({ error: 'Invalid persona ID' }, 400);
    let counterparts: PersonaCounterpart[] | undefined;
    try {
      counterparts = readPersonaCounterparts(root, personaId);
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : 'Invalid persona frontmatter' }, 400);
    }
    if (counterparts === undefined) return context.json({ error: 'Persona not found' }, 404);

    const config = options.getConfig();
    const requestedAccount = context.req.query('account');
    let selectedAccount: number | undefined;
    if (requestedAccount !== undefined) {
      selectedAccount = positiveId(requestedAccount);
      if (selectedAccount === undefined || !config.accounts.some(({ uin }) => uin === selectedAccount)) {
        return context.json({ error: 'Invalid counterpart account' }, 400);
      }
    }
    const accounts = selectedAccount === undefined ? configuredAccounts(config) : [selectedAccount];
    const bindings = accounts.flatMap((account) => options.repository.listPersonaCounterpartBindings(account, personaId))
      .map((binding) => ({
        ...binding,
        senderName: redactSensitiveText(options.repository.latestSenderNameForAccount(binding.account, binding.userId) ?? ''),
      }));
    const claims = accounts.flatMap((account) => options.repository.listPersonaCounterpartClaims(account, personaId))
      .filter((claim) => claim.status === 'pending')
      .map((claim) => ({
        ...claim,
        senderName: redactSensitiveText(options.repository.senderNameFor(claim.sessionId, claim.userId) ?? ''),
      }));
    return context.json({ personaId, counterparts, bindings, claims });
  });

  app.post('/api/personas/:id/counterparts/:name/bindings', async (context) => {
    const personaId = context.req.param('id');
    const name = context.req.param('name');
    if (!validPersonaId(personaId.toLowerCase())) return context.json({ error: 'Invalid persona ID' }, 400);
    let counterparts: PersonaCounterpart[] | undefined;
    try {
      counterparts = readPersonaCounterparts(root, personaId);
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : 'Invalid persona frontmatter' }, 400);
    }
    if (counterparts === undefined) return context.json({ error: 'Persona not found' }, 404);
    if (!counterpartByName(counterparts, name)) return context.json({ error: 'Counterpart not found' }, 404);

    const config = options.getConfig();
    const rawAccount = context.req.query('account');
    const account = rawAccount === undefined && configuredAccounts(config).length === 1
      ? configuredAccounts(config)[0]
      : rawAccount === undefined ? undefined : positiveId(rawAccount);
    if (account === undefined || !config.accounts.some(({ uin }) => uin === account)) {
      return context.json({ error: 'A valid counterpart account is required' }, 400);
    }
    let rawBody: unknown;
    try { rawBody = await context.req.json(); } catch { return context.json({ error: 'Invalid JSON' }, 400); }
    const parsedBody = bindingBodySchema.safeParse(rawBody);
    if (!parsedBody.success) return context.json({ error: 'Invalid counterpart userId' }, 400);
    const createdAt = options.now();
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) return context.json({ error: 'Invalid counterpart time' }, 500);

    let saved: ReturnType<StoreRepository['createPersonaCounterpartBinding']> | undefined;
    let created = false;
    options.repository.transaction(() => {
      saved = options.repository.listPersonaCounterpartBindings(account, personaId)
        .find((binding) => binding.counterpartName === name && binding.userId === parsedBody.data.userId);
      if (!saved) {
        saved = options.repository.createPersonaCounterpartBinding({
          account,
          personaId,
          counterpartName: name,
          userId: parsedBody.data.userId,
          createdAt,
        });
        created = true;
      }
      options.repository.deletePersonaCounterpartClaim(account, personaId, name, parsedBody.data.userId);
    });
    if (!saved) return context.json({ error: 'Counterpart binding read-back failed' }, 500);
    return context.json(saved, created ? 201 : 200);
  });

  app.delete('/api/personas/:id/counterparts/:name/bindings/:userId', (context) => {
    const personaId = context.req.param('id');
    const name = context.req.param('name');
    const userId = positiveId(context.req.param('userId'));
    if (!validPersonaId(personaId.toLowerCase())) return context.json({ error: 'Invalid persona ID' }, 400);
    if (userId === undefined) return context.json({ error: 'Invalid counterpart userId' }, 400);
    let counterparts: PersonaCounterpart[] | undefined;
    try {
      counterparts = readPersonaCounterparts(root, personaId);
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : 'Invalid persona frontmatter' }, 400);
    }
    if (counterparts === undefined) return context.json({ error: 'Persona not found' }, 404);
    if (!counterpartByName(counterparts, name)) return context.json({ error: 'Counterpart not found' }, 404);
    const config = options.getConfig();
    const rawAccount = context.req.query('account');
    const account = rawAccount === undefined && configuredAccounts(config).length === 1
      ? configuredAccounts(config)[0]
      : rawAccount === undefined ? undefined : positiveId(rawAccount);
    if (account === undefined || !config.accounts.some(({ uin }) => uin === account)) {
      return context.json({ error: 'A valid counterpart account is required' }, 400);
    }
    const deleted = options.repository.deletePersonaCounterpartBinding(account, personaId, name, userId);
    return deleted ? context.json({ deleted: true }) : context.json({ error: 'Counterpart binding not found' }, 404);
  });

  app.post('/api/personas/:id/counterparts/:name/claims/:userId/dismiss', (context) => {
    const personaId = context.req.param('id');
    const name = context.req.param('name');
    const userId = positiveId(context.req.param('userId'));
    if (!validPersonaId(personaId.toLowerCase())) return context.json({ error: 'Invalid persona ID' }, 400);
    if (userId === undefined) return context.json({ error: 'Invalid counterpart userId' }, 400);
    let counterparts: PersonaCounterpart[] | undefined;
    try {
      counterparts = readPersonaCounterparts(root, personaId);
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : 'Invalid persona frontmatter' }, 400);
    }
    if (counterparts === undefined) return context.json({ error: 'Persona not found' }, 404);
    if (!counterpartByName(counterparts, name)) return context.json({ error: 'Counterpart not found' }, 404);
    const config = options.getConfig();
    const rawAccount = context.req.query('account');
    const account = rawAccount === undefined && configuredAccounts(config).length === 1
      ? configuredAccounts(config)[0]
      : rawAccount === undefined ? undefined : positiveId(rawAccount);
    if (account === undefined || !config.accounts.some(({ uin }) => uin === account)) {
      return context.json({ error: 'A valid counterpart account is required' }, 400);
    }
    const claim = options.repository.dismissPersonaCounterpartClaim(account, personaId, name, userId);
    return claim ? context.json(claim) : context.json({ error: 'Counterpart claim not found' }, 404);
  });
}
