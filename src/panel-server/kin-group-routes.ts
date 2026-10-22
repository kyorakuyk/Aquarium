import type { Hono } from 'hono';
import { z } from 'zod';
import type { StoreRepository } from '../store/repository.ts';
import { syncKinRelays } from '../core/privacy/kin-relay.ts';

export interface KinGroupRouteOptions {
  repository: StoreRepository;
  accounts: () => Array<{ account: number; name: string }>;
  now?: () => number;
}

const createSchema = z.object({ name: z.string().trim().min(1).max(40) }).strict();
const membersSchema = z.object({
  accounts: z.array(z.number().int().positive()).max(100),
}).strict();

function positiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function registerKinGroupRoutes(app: Hono, options: KinGroupRouteOptions): void {
  const now = options.now ?? Date.now;

  app.get('/api/kin-groups', (context) => context.json({
    accounts: options.accounts().map(({ account, name }) => ({ account, name }))
      .sort((first, second) => first.account - second.account),
    groups: options.repository.listKinGroups(),
  }));

  app.post('/api/kin-groups', async (context) => {
    let raw: unknown;
    try { raw = await context.req.json(); } catch { return context.json({ error: 'Invalid JSON' }, 400); }
    const parsed = createSchema.safeParse(raw);
    if (!parsed.success) return context.json({ error: 'Invalid kin group name' }, 400);
    try {
      const id = options.repository.createKinGroup(parsed.data.name);
      return context.json({ id, name: parsed.data.name, accounts: [] }, 201);
    } catch {
      return context.json({ error: 'A kin group with this name already exists' }, 409);
    }
  });

  app.put('/api/kin-groups/:id/members', async (context) => {
    const id = positiveInteger(context.req.param('id'));
    if (id === undefined) return context.json({ error: 'Invalid kin group ID' }, 400);
    let raw: unknown;
    try { raw = await context.req.json(); } catch { return context.json({ error: 'Invalid JSON' }, 400); }
    const parsed = membersSchema.safeParse(raw);
    if (!parsed.success) return context.json({ error: 'Invalid kin group members' }, 400);
    const allowedAccounts = new Set(options.accounts().map(({ account }) => account));
    if (parsed.data.accounts.some((account) => !allowedAccounts.has(account))) {
      return context.json({ error: 'Unknown account' }, 400);
    }
    const previousAccounts = options.repository.kinGroupAccounts(id);
    try {
      const updated = options.repository.transaction(() => {
        if (!options.repository.setKinGroupMembers(id, parsed.data.accounts)) return false;
        syncKinRelays(options.repository, now(), previousAccounts);
        return true;
      });
      if (!updated) return context.json({ error: 'Kin group not found' }, 404);
      return context.json(options.repository.listKinGroups().find((group) => group.id === id));
    } catch {
      return context.json({ error: 'Kin group membership could not be saved' }, 500);
    }
  });
}
