import { Hono } from 'hono';
import { z } from 'zod';
import type { ProtocolAdapter } from '../adapters/types.ts';
import type { AquariumConfig } from '../config/schema.ts';
import { AquariumConfigSchema, ModeScheduleSchema } from '../config/schema.ts';
import { resolveInteractions, resolveSession } from '../config/resolve.ts';
import { parseSessionId } from '../core/conversation/sessions.ts';
import { sessionId, type SessionKey } from '../core/shared/events.ts';
import type { StoreRepository } from '../store/repository.ts';
import type { ContactSnapshot, PanelAccountRuntime } from './types.ts';

const ratePatchSchema = z.object({
  perUserPerMinute: z.number().int().positive().nullable().optional(),
  perSessionPerMinute: z.number().int().positive().nullable().optional(),
  minIntervalSec: z.number().positive().nullable().optional(),
}).strict();

const interactionFeaturePatchSchema = z.object({
  enabled: z.boolean().nullable().optional(),
}).strict().nullable().optional();

const interactionsPatchSchema = z.object({
  react: interactionFeaturePatchSchema,
  poke: interactionFeaturePatchSchema,
  recall: interactionFeaturePatchSchema,
  admin: interactionFeaturePatchSchema,
}).strict().nullable().optional();

const sessionPatchSchema = z.object({
  enabled: z.boolean().nullable().optional(),
  mode: z.enum(['mention_only', 'active', 'natural', 'busy']).nullable().optional(),
  modeSchedule: ModeScheduleSchema.nullable().optional(),
  proactiveCooldownSec: z.number().int().min(0).max(3600).nullable().optional(),
  talkOffset: z.number().int().min(-2).max(2).nullable().optional(),
  innerVoice: z.enum(['full', 'light', 'hidden']).nullable().optional(),
  nicknames: z.array(z.string()).nullable().optional(),
  contextMessages: z.number().int().positive().nullable().optional(),
  rate: ratePatchSchema.nullable().optional(),
  groupNote: z.string().nullable().optional(),
  interactions: interactionsPatchSchema,
}).strict();

const defaultsPatchSchema = z.object({
  enabled: z.boolean().optional(),
  mode: z.enum(['mention_only', 'active', 'natural', 'busy']).optional(),
  modeSchedule: ModeScheduleSchema.optional(),
  proactiveCooldownSec: z.number().int().min(0).max(3600).optional(),
  talkOffset: z.number().int().min(-2).max(2).optional(),
  nicknames: z.array(z.string()).optional(),
  contextMessages: z.number().int().positive().optional(),
  rate: z.object({
    perUserPerMinute: z.number().int().positive().optional(),
    perSessionPerMinute: z.number().int().positive().optional(),
    minIntervalSec: z.number().positive().optional(),
  }).strict().optional(),
  groupNote: z.string().optional(),
}).strict();

// Exact display names are the approved fallback until a real contact snapshot confirms stable device IDs.
const DEVICE_CONTACT_NAMES = new Set(['我的电脑', '我的手机', '我的Pad', '我的平板']);

function parseJsonBody<T>(body: unknown, schema: z.ZodType<T>): T | undefined {
  const result = schema.safeParse(body);
  return result.success ? result.data : undefined;
}

function interactionSettingsForPanel(config: AquariumConfig, key: SessionKey) {
  const settings = resolveInteractions(config, key);
  return { react: settings.react, poke: settings.poke, recall: settings.recall, admin: settings.admin };
}

export interface SessionRouteOptions {
  getConfig: () => AquariumConfig;
  saveConfig: (config: AquariumConfig) => void | Promise<void>;
  repository: StoreRepository;
  accounts: () => PanelAccountRuntime[];
  loadContacts: (runtime: PanelAccountRuntime) => Promise<ContactSnapshot>;
  serializeConfigWrite: <T>(task: () => Promise<T>) => Promise<T>;
}

export function registerSessionRoutes(app: Hono, options: SessionRouteOptions): void {
  app.get('/api/defaults', (context) => context.json(options.getConfig().defaults));

  app.patch('/api/defaults', async (context) => {
    let rawBody: unknown;
    try { rawBody = await context.req.json(); } catch { return context.json({ error: 'Invalid JSON' }, 400); }
    const patch = parseJsonBody(rawBody, defaultsPatchSchema);
    if (!patch) return context.json({ error: 'Invalid defaults patch' }, 400);

    return options.serializeConfigWrite(async () => {
      const config = options.getConfig();
      const defaults = {
        ...config.defaults,
        ...patch,
        rate: { ...config.defaults.rate, ...(patch.rate ?? {}) },
      };
      const nextConfig = AquariumConfigSchema.parse({ ...config, defaults });
      await options.saveConfig(nextConfig);
      return context.json(nextConfig.defaults);
    });
  });

  app.get('/api/sessions', async (context) => {
    const config = options.getConfig();
    const runtimes = options.accounts();
    const snapshots = await Promise.all(runtimes.map(options.loadContacts));
    const rows = new Map<string, { key: SessionKey; name: string; memberCount?: number; degraded: boolean }>();
    const degradedByAccount = new Map<number, boolean>();
    const excludedPrivateSessionIds = new Set<string>();
    for (const [index, runtime] of runtimes.entries()) {
      const snapshot = snapshots[index] ?? { groups: [], friends: [], degraded: true };
      const degraded = snapshot.degraded || runtime.getStatus() !== 'online';
      degradedByAccount.set(runtime.adapter.account, degraded);
      for (const group of snapshot.groups) {
        const key: SessionKey = { account: runtime.adapter.account, kind: 'group', peer: group.groupId };
        rows.set(sessionId(key), { key, name: group.name, memberCount: group.memberCount, degraded });
      }
      for (const friend of snapshot.friends) {
        const key: SessionKey = { account: runtime.adapter.account, kind: 'private', peer: friend.userId };
        const id = sessionId(key);
        if (
          friend.userId === runtime.adapter.account
          || DEVICE_CONTACT_NAMES.has(friend.nickname)
          || (friend.remark !== undefined && DEVICE_CONTACT_NAMES.has(friend.remark))
        ) {
          excludedPrivateSessionIds.add(id);
          continue;
        }
        rows.set(id, { key, name: friend.remark || friend.nickname, degraded });
      }
    }
    for (const configuredId of Object.keys(config.sessions)) {
      const key = parseSessionId(configuredId);
      if (
        key
        && !(key.kind === 'private' && (key.peer === key.account || excludedPrivateSessionIds.has(configuredId)))
        && runtimes.some((runtime) => runtime.adapter.account === key.account)
        && !rows.has(configuredId)
      ) {
        rows.set(configuredId, { key, name: `${key.kind === 'group' ? '群' : '私聊'} ${key.peer}（未获取名称）`, degraded: degradedByAccount.get(key.account) ?? true });
      }
    }
    const result = [...rows.entries()].map(([id, row]) => {
      const effective = resolveSession(config, row.key);
      const runtime = runtimes.find((candidate) => candidate.adapter.account === row.key.account);
      return {
        sessionId: id,
        name: row.name,
        kind: row.key.kind,
        degraded: row.degraded || !runtime || runtime.getStatus() !== 'online',
        ...(row.memberCount === undefined ? {} : { memberCount: row.memberCount }),
        enabled: effective.enabled,
        lastMessageAt: options.repository.lastMessageTime(id),
        overrides: Object.keys(config.sessions[id] ?? {}),
        interactionOverrides: Object.keys(config.sessions[id]?.interactions ?? {}),
        interactions: interactionSettingsForPanel(config, row.key),
        effective: {
          mode: effective.mode,
          modeSchedule: effective.modeSchedule,
          proactiveCooldownSec: effective.proactiveCooldownSec,
          talkOffset: effective.talkOffset,
          nicknames: effective.nicknames,
          contextMessages: effective.contextMessages,
          rate: effective.rate,
          groupNote: effective.groupNote,
          innerVoice: config.sessions[id]?.innerVoice ?? null,
        },
      };
    });
    result.sort((first, second) => {
      if (first.kind !== second.kind) return first.kind === 'group' ? -1 : 1;
      if (first.enabled !== second.enabled) return first.enabled ? -1 : 1;
      if (first.lastMessageAt !== second.lastMessageAt) {
        if (first.lastMessageAt === null) return 1;
        if (second.lastMessageAt === null) return -1;
        return second.lastMessageAt - first.lastMessageAt;
      }
      return first.name.localeCompare(second.name, 'zh-CN');
    });
    return context.json(result);
  });

  app.patch('/api/sessions/:sessionId', async (context) => {
    const id = context.req.param('sessionId');
    const key = parseSessionId(id);
    if (!key || !options.accounts().some((runtime) => runtime.adapter.account === key.account)) {
      return context.json({ error: 'Invalid session' }, 400);
    }
    let rawBody: unknown;
    try { rawBody = await context.req.json(); } catch { return context.json({ error: 'Invalid JSON' }, 400); }
    const patch = parseJsonBody(rawBody, sessionPatchSchema);
    if (!patch) return context.json({ error: 'Invalid session patch' }, 400);

    return options.serializeConfigWrite(async () => {
      const config = options.getConfig();
      const updated = { ...(config.sessions[id] ?? {}) } as Record<string, unknown>;
      for (const [field, value] of Object.entries(patch)) {
        if (field === 'interactions') {
          if (value === null) {
            delete updated.interactions;
            continue;
          }
          if (value && typeof value === 'object') {
            const interactions = { ...((updated.interactions as Record<string, unknown> | undefined) ?? {}) };
            for (const [feature, featureValue] of Object.entries(value)) {
              if (featureValue === null) {
                delete interactions[feature];
                continue;
              }
              if (featureValue && typeof featureValue === 'object') {
                const settings = { ...((interactions[feature] as Record<string, unknown> | undefined) ?? {}) };
                for (const [setting, settingValue] of Object.entries(featureValue)) {
                  if (settingValue === null) delete settings[setting];
                  else if (settingValue !== undefined) settings[setting] = settingValue;
                }
                if (Object.keys(settings).length === 0) delete interactions[feature];
                else interactions[feature] = settings;
              }
            }
            if (Object.keys(interactions).length === 0) delete updated.interactions;
            else updated.interactions = interactions;
          }
          continue;
        }
        if (field !== 'rate') {
          if (value === null) delete updated[field];
          else if (value !== undefined) updated[field] = value;
          continue;
        }
        if (value === null) {
          delete updated.rate;
          continue;
        }
        if (value) {
          const rate = { ...((updated.rate as Record<string, unknown> | undefined) ?? {}) };
          for (const [rateField, rateValue] of Object.entries(value)) {
            if (rateValue === null) delete rate[rateField];
            else if (rateValue !== undefined) rate[rateField] = rateValue;
          }
          if (Object.keys(rate).length === 0) delete updated.rate;
          else updated.rate = rate;
        }
      }
      const sessions = { ...config.sessions };
      if (Object.keys(updated).length === 0) delete sessions[id];
      else sessions[id] = updated as AquariumConfig['sessions'][string];
      const nextConfig = AquariumConfigSchema.parse({ ...config, sessions });
      await options.saveConfig(nextConfig);
      return context.json({
        sessionId: id,
        enabled: resolveSession(nextConfig, key).enabled,
        overrides: Object.keys(nextConfig.sessions[id] ?? {}),
        interactionOverrides: Object.keys(nextConfig.sessions[id]?.interactions ?? {}),
        interactions: interactionSettingsForPanel(nextConfig, key),
      });
    });
  });
}
