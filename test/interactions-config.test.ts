import assert from 'node:assert/strict';
import test from 'node:test';
import { AquariumConfigSchema } from '../src/config/schema.ts';
import { groupSession, makeConfig } from './pipeline-test-helpers.ts';

test('interaction capabilities default disabled and admin stays in dry-run', () => {
  const config = AquariumConfigSchema.parse(makeConfig());
  const interactions = Reflect.get(config, 'interactions') as Record<string, unknown>;
  assert.deepEqual(interactions, {
    master_ids: [],
    react: { enabled: false, prob_scale: 1, per_hour_max: 12, per_sender_gap_s: 60 },
    poke: { enabled: false, poke_back: true, proactive: false, per_hour_max: 6, per_user_gap_s: 600 },
    recall: { enabled: false, self_auto: true, others: false },
    admin: { enabled: false, mute_max_s: 600, dry_run: true },
  });
});

test('session interaction overrides are partial and inherit root limits', async () => {
  const base = makeConfig();
  const session = `${groupSession.account}:group:${groupSession.peer}`;
  const config = AquariumConfigSchema.parse({
    ...base,
    interactions: {
      ...Reflect.get(base, 'interactions'),
      react: { enabled: false, prob_scale: 0.5, per_hour_max: 8, per_sender_gap_s: 90 },
      admin: { enabled: false, mute_max_s: 120, dry_run: true },
    },
    sessions: { [session]: { interactions: {
      react: { enabled: true, per_hour_max: 12, per_sender_gap_s: 60 },
      admin: { dry_run: false, mute_max_s: 600 },
    } } },
  });
  const sessionSettings = Reflect.get(config.sessions[session] ?? {}, 'interactions') as Record<string, unknown>;
  assert.deepEqual(sessionSettings, {
    react: { enabled: true, per_hour_max: 12, per_sender_gap_s: 60 },
    admin: { dry_run: false, mute_max_s: 600 },
  });

  const resolverModule = await import('../src/config/resolve.ts');
  const resolver = Reflect.get(resolverModule, 'resolveInteractions');
  assert.equal(typeof resolver, 'function');
  if (typeof resolver !== 'function') return;
  const effective = resolver(config, groupSession) as { react: unknown; poke: unknown; admin: unknown };
  const root = Reflect.get(config, 'interactions') as Record<string, unknown>;
  assert.deepEqual(effective.react, {
    enabled: true, prob_scale: 0.5, per_hour_max: 8, per_sender_gap_s: 90,
  });
  assert.deepEqual(effective.poke, root.poke);
  assert.deepEqual(effective.admin, { enabled: false, mute_max_s: 120, dry_run: false });
});
