import type { Hono } from 'hono';
import { z } from 'zod';
import {
  AquariumConfigSchema,
  ProviderConfigSchema,
  SlotEntryConfigSchema,
  type AquariumConfig,
} from '../config/schema.ts';
import type { StoreRepository } from '../store/repository.ts';
import type { UsageAttempt } from '../llm/slots.ts';
import { clearProviderClients } from '../llm/client.ts';
import { maskSecret, readEnvKey, writeEnvKey } from './env-file.ts';

const providerNameSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const apiProviderBodySchema = z.object({
  kind: z.literal('api'),
  label: z.string().min(1).max(80).optional(),
  baseUrl: z.string().min(1).max(2048),
  apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  reasoningField: z.string().regex(/^(?:[a-z][a-z0-9_]*|none)$/).default('reasoning_effort'),
}).strict();
const cliProviderBodySchema = z.object({
  kind: z.literal('cli'),
  label: z.string().min(1).max(80).optional(),
  command: z.string().min(1).max(2048),
  args: z.array(z.string().max(2048)).max(64).default([]),
  prewarm: z.boolean().default(false),
  timeoutSec: z.number().int().min(1).max(3600).default(120),
}).strict();
const providerBodySchema = z.discriminatedUnion('kind', [apiProviderBodySchema, cliProviderBodySchema]);
const providerPatchSchema = z.object({
  label: z.string().min(1).max(80).nullable().optional(),
  baseUrl: z.string().min(1).max(2048).optional(),
  apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/).optional(),
  reasoningField: z.string().regex(/^(?:[a-z][a-z0-9_]*|none)$/).optional(),
  command: z.string().min(1).max(2048).optional(),
  args: z.array(z.string().max(2048)).max(64).optional(),
  prewarm: z.boolean().optional(),
  timeoutSec: z.number().int().min(1).max(3600).optional(),
}).strict();
const keyBodySchema = z.object({ key: z.string().min(1).max(4096) }).strict();
const testBodySchema = z.object({ model: z.string().min(1).max(256).optional() }).strict();

export interface ProviderRouteOptions {
  getConfig: () => AquariumConfig;
  saveConfig: (config: AquariumConfig) => void | Promise<void>;
  repository: StoreRepository;
  serializeConfigWrite: <T>(task: () => Promise<T>) => Promise<T>;
  envPath: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  testProvider?: (provider: string, model: string, config: AquariumConfig) => Promise<{ ok: boolean; latencyMs: number; error?: string }>;
}

function parseJsonBody<T>(raw: unknown, schema: z.ZodType<T>): T | undefined {
  const result = schema.safeParse(raw);
  return result.success ? result.data : undefined;
}

function safeApiKeyEnv(provider: AquariumConfig['providers'][string]): string | null {
  return provider.kind === 'api' ? provider.apiKeyEnv : null;
}

export function registerProviderRoutes(app: Hono, options: ProviderRouteOptions): void {
  const now = options.now ?? Date.now;
  const env = options.env ?? process.env;

  const keyStatus = (provider: AquariumConfig['providers'][string]) => {
    const name = safeApiKeyEnv(provider);
    if (!name) return { set: false, last4: '' };
    let fromFile: string | undefined;
    try {
      fromFile = readEnvKey(options.envPath, name);
    } catch {
      fromFile = undefined;
    }
    return maskSecret(fromFile ?? env[name]);
  };

  const cliStatus = (provider: AquariumConfig['providers'][string]) => provider.kind === 'cli'
    ? { state: 'stopped', pid: null as number | null, served: 0 }
    : undefined;

  app.get('/api/models', (context) => {
    const config = options.getConfig();
    return context.json({
      providers: Object.entries(config.providers).map(([id, provider]) => ({
        id,
        kind: provider.kind,
        label: provider.label ?? id,
        ...(provider.kind === 'api'
          ? { baseUrl: provider.baseUrl, reasoningField: provider.reasoningField }
          : { command: provider.command, args: provider.args, prewarm: provider.prewarm, timeoutSec: provider.timeoutSec }),
        keyStatus: keyStatus(provider),
        ...(provider.kind === 'cli' ? { runtime: cliStatus(provider) } : {}),
      })),
      slots: config.slots,
    });
  });

  app.post('/api/providers', async (context) => {
    let rawBody: unknown;
    try { rawBody = await context.req.json(); } catch { return context.json({ error: 'Invalid JSON' }, 400); }
    const parsed = parseJsonBody(rawBody, z.object({ id: providerNameSchema, provider: providerBodySchema }).strict());
    if (!parsed) return context.json({ error: 'Invalid provider' }, 400);
    const provider = ProviderConfigSchema.safeParse(parsed.provider);
    if (!provider.success) return context.json({ error: 'Invalid provider' }, 400);

    return options.serializeConfigWrite(async () => {
      const config = options.getConfig();
      if (config.providers[parsed.id]) return context.json({ error: 'Provider already exists' }, 409);
      const next = AquariumConfigSchema.safeParse({
        ...config,
        providers: { ...config.providers, [parsed.id]: provider.data },
      });
      if (!next.success) return context.json({ error: 'Invalid provider' }, 400);
      await options.saveConfig(next.data);
      const stored = next.data.providers[parsed.id];
      if (!stored) return context.json({ error: 'Provider was not saved' }, 500);
      return context.json({
        id: parsed.id,
        kind: stored.kind,
        ...(stored.kind === 'cli'
          ? { runtime: { state: 'stopped', pid: null, served: 0 } }
          : { keyStatus: keyStatus(stored) }),
      }, 201);
    });
  });

  app.patch('/api/providers/:id', async (context) => {
    const id = context.req.param('id');
    if (!providerNameSchema.safeParse(id).success) return context.json({ error: 'Unknown provider' }, 404);
    let rawBody: unknown;
    try { rawBody = await context.req.json(); } catch { return context.json({ error: 'Invalid JSON' }, 400); }
    const patch = parseJsonBody(rawBody, providerPatchSchema);
    if (!patch) return context.json({ error: 'Invalid provider patch' }, 400);

    return options.serializeConfigWrite(async () => {
      const config = options.getConfig();
      const current = config.providers[id];
      if (!current) return context.json({ error: 'Unknown provider' }, 404);
      const { label, ...fields } = patch;
      const base = current.kind === 'api'
        ? {
          kind: 'api' as const,
          baseUrl: current.baseUrl,
          apiKeyEnv: current.apiKeyEnv,
          reasoningField: current.reasoningField,
        }
        : {
          kind: 'cli' as const,
          command: current.command,
          args: current.args,
          prewarm: current.prewarm,
          timeoutSec: current.timeoutSec,
        };
      const allowed = current.kind === 'api'
        ? ['baseUrl', 'apiKeyEnv', 'reasoningField']
        : ['command', 'args', 'prewarm', 'timeoutSec'];
      if (Object.keys(fields).some((key) => !allowed.includes(key))) {
        return context.json({ error: 'Invalid provider patch' }, 400);
      }
      const merged = {
        ...base,
        ...fields,
        ...(label !== undefined ? { label: label === null ? undefined : label } : current.label !== undefined ? { label: current.label } : {}),
      };
      const provider = ProviderConfigSchema.safeParse(merged);
      if (!provider.success) return context.json({ error: 'Invalid provider patch' }, 400);
      const next = AquariumConfigSchema.safeParse({
        ...config,
        providers: { ...config.providers, [id]: provider.data },
      });
      if (!next.success) return context.json({ error: 'Invalid provider patch' }, 400);
      await options.saveConfig(next.data);
      return context.json({ ok: true, keyStatus: keyStatus(provider.data) });
    });
  });

  app.delete('/api/providers/:id', (context) => {
    const id = context.req.param('id');
    return options.serializeConfigWrite(async () => {
      const config = options.getConfig();
      if (!config.providers[id]) return context.json({ error: 'Unknown provider' }, 404);
      const referencedBy = Object.entries(config.slots)
        .filter(([, chain]) => chain.some((entry) => entry.provider === id))
        .map(([slot]) => slot);
      if (referencedBy.length > 0) return context.json({ error: 'Provider is referenced', slots: referencedBy }, 409);
      const providers = { ...config.providers };
      delete providers[id];
      const next = AquariumConfigSchema.safeParse({ ...config, providers });
      if (!next.success) return context.json({ error: 'Invalid configuration after delete' }, 400);
      await options.saveConfig(next.data);
      return context.json({ ok: true });
    });
  });

  app.put('/api/providers/:id/key', async (context) => {
    const id = context.req.param('id');
    let rawBody: unknown;
    try { rawBody = await context.req.json(); } catch { return context.json({ error: 'Invalid JSON' }, 400); }
    const body = parseJsonBody(rawBody, keyBodySchema);
    if (!body) return context.json({ error: 'Invalid key' }, 400);
    if (/[\r\n\u0000]/u.test(body.key)) return context.json({ error: 'Invalid key' }, 400);

    return options.serializeConfigWrite(async () => {
      const provider = options.getConfig().providers[id];
      if (!provider) return context.json({ error: 'Unknown provider' }, 404);
      if (provider.kind !== 'api') return context.json({ error: 'CLI providers do not use API keys' }, 400);
      try {
        writeEnvKey(options.envPath, provider.apiKeyEnv, body.key);
      } catch {
        return context.json({ error: 'Unable to write .env' }, 500);
      }
      env[provider.apiKeyEnv] = body.key;
      clearProviderClients();
      return context.json({ set: true, last4: body.key.slice(-4) });
    });
  });

  app.put('/api/slots/:slot', async (context) => {
    const slot = context.req.param('slot');
    const slotName = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).safeParse(slot);
    if (!slotName.success) return context.json({ error: 'Unknown slot' }, 404);
    let rawBody: unknown;
    try { rawBody = await context.req.json(); } catch { return context.json({ error: 'Invalid JSON' }, 400); }
    const chain = parseJsonBody(rawBody, z.object({ chain: z.array(SlotEntryConfigSchema).min(1).max(8) }).strict());
    if (!chain) return context.json({ error: 'Invalid slot chain' }, 400);

    return options.serializeConfigWrite(async () => {
      const config = options.getConfig();
      const unknownProvider = chain.chain.find((entry) => !config.providers[entry.provider]);
      if (unknownProvider) return context.json({ error: 'Unknown provider', provider: unknownProvider.provider }, 400);
      const next = AquariumConfigSchema.safeParse({
        ...config,
        slots: { ...config.slots, [slot]: chain.chain },
      });
      if (!next.success) return context.json({ error: 'Invalid slot chain' }, 400);
      await options.saveConfig(next.data);
      return context.json({ chain: next.data.slots[slot] });
    });
  });

  app.post('/api/providers/:id/test', async (context) => {
    const id = context.req.param('id');
    let rawBody: unknown = {};
    try { rawBody = await context.req.json(); } catch { rawBody = {}; }
    const body = parseJsonBody(rawBody, testBodySchema);
    if (!body) return context.json({ error: 'Invalid test request' }, 400);

    const config = options.getConfig();
    const provider = config.providers[id];
    if (!provider) return context.json({ error: 'Unknown provider' }, 404);
    const model = body.model ?? config.slots.reply?.[0]?.model;
    const price = model ? config.pricing[model] : undefined;
    if (!model || !price) return context.json({ error: 'Model is not priced' }, 400);

    const startedAt = now();
    let outcome: { ok: boolean; latencyMs: number; error?: string };
    try {
      if (options.testProvider) {
        outcome = await options.testProvider(id, model, config);
      } else if (provider.kind === 'api') {
        const { createOpenAIClient } = await import('../llm/client.ts');
        const client = createOpenAIClient(provider, env);
        await client.chat.completions.create({
          model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
        }, { timeout: 30_000, maxRetries: 0 });
        outcome = { ok: true, latencyMs: Math.max(0, now() - startedAt) };
      } else {
        outcome = { ok: false, latencyMs: Math.max(0, now() - startedAt), error: 'CLI provider is not available' };
      }
    } catch {
      outcome = { ok: false, latencyMs: Math.max(0, now() - startedAt), error: 'Connection test failed' };
    }

    const attempt: UsageAttempt = {
      time: now(),
      account: null,
      slot: 'test',
      provider: id,
      model,
      inputTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
      costCny: 0,
      latencyMs: outcome.latencyMs,
      ok: outcome.ok,
    };
    options.repository.recordUsage(attempt);
    return context.json(outcome);
  });
}
