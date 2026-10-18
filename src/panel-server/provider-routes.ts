import type { Context, Hono } from 'hono';
import { z } from 'zod';
import {
  AquariumConfigSchema,
  ProviderConfigSchema,
  ReasoningFieldSchema,
  SlotEntryConfigSchema,
  type AquariumConfig,
} from '../config/schema.ts';
import type { StoreRepository } from '../store/repository.ts';
import type { UsageAttempt } from '../llm/slots.ts';
import { clearProviderClients } from '../llm/client.ts';
import { buildCliInput, getCliRuntime, type CliRuntime } from '../llm/cli.ts';
import { maskSecret, readEnvKey, writeEnvKey } from './env-file.ts';

const providerNameSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const apiProviderBodySchema = z.object({
  kind: z.literal('api'),
  label: z.string().min(1).max(80).optional(),
  baseUrl: z.string().min(1).max(2048),
  apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  reasoningField: ReasoningFieldSchema.default('reasoning_effort'),
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
  reasoningField: ReasoningFieldSchema.optional(),
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
  cliRuntime?: CliRuntime;
}

function parseJsonBody<T>(raw: unknown, schema: z.ZodType<T>): T | undefined {
  const result = schema.safeParse(raw);
  return result.success ? result.data : undefined;
}

function safeApiKeyEnv(provider: AquariumConfig['providers'][string]): string | null {
  return provider.kind === 'api' ? provider.apiKeyEnv : null;
}

function safeBaseUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null;
    return url.toString().replace(/\/$/u, '');
  } catch {
    return null;
  }
}

function displayBaseUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}${url.search}`.replace(/\/$/u, '');
  } catch {
    return raw;
  }
}

export function registerProviderRoutes(app: Hono, options: ProviderRouteOptions): void {
  const now = options.now ?? Date.now;
  const env = options.env ?? process.env;
  const cliRuntime = options.cliRuntime ?? getCliRuntime();

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


  app.get('/api/models', (context) => {
    const config = options.getConfig();
    return context.json({
      providers: Object.entries(config.providers).map(([id, provider]) => ({
        id,
        kind: provider.kind,
        label: provider.label ?? id,
        ...(provider.kind === 'api'
          ? { baseUrl: displayBaseUrl(provider.baseUrl), reasoningField: provider.reasoningField, apiKeyEnv: provider.apiKeyEnv }
          : { command: provider.command, args: provider.args, prewarm: provider.prewarm, timeoutSec: provider.timeoutSec }),
        keyStatus: keyStatus(provider),
        ...(provider.kind === 'cli' ? { runtime: cliRuntime.status(id) } : {}),
      })),
      slots: config.slots,
      pricing: config.pricing,
    });
  });

  app.post('/api/providers', async (context) => {
    let rawBody: unknown;
    try { rawBody = await context.req.json(); } catch { return context.json({ error: 'Invalid JSON' }, 400); }
    const parsed = parseJsonBody(rawBody, z.object({ id: providerNameSchema, provider: providerBodySchema }).strict());
    if (!parsed) return context.json({ error: 'Invalid provider' }, 400);
    const provider = ProviderConfigSchema.safeParse(parsed.provider);
    if (!provider.success) return context.json({ error: 'Invalid provider' }, 400);
    if (provider.data.kind === 'api' && !safeBaseUrl(provider.data.baseUrl)) {
      return context.json({ error: 'Invalid base URL' }, 400);
    }

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
          ? { runtime: cliRuntime.status(parsed.id) }
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
      if (current.kind === 'api' && patch.baseUrl !== undefined && !safeBaseUrl(patch.baseUrl)) {
        return context.json({ error: 'Invalid base URL' }, 400);
      }
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
      return context.json({ set: true, last4: maskSecret(body.key).last4 });
    });
  });

  const updateSlot = async (context: Context) => {
    const slotName = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).safeParse(context.req.param('slot'));
    if (!slotName.success) return context.json({ error: 'Unknown slot' }, 404);
    const slot = slotName.data;
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
  };
  app.put('/api/slots/:slot', updateSlot);
  app.patch('/api/slots/:slot', updateSlot);

  app.post('/api/providers/:id/test', async (context) => {
    const id = context.req.param('id');
    let rawBody: unknown = {};
    try { rawBody = await context.req.json(); } catch { rawBody = {}; }
    const body = parseJsonBody(rawBody, testBodySchema);
    if (!body) return context.json({ error: 'Invalid test request' }, 400);

    const config = options.getConfig();
    const provider = config.providers[id];
    if (!provider) return context.json({ error: 'Unknown provider' }, 404);
    const model = body.model ?? (provider.kind === 'cli' ? 'cli' : config.slots.reply?.[0]?.model);
    if (!model) return context.json({ error: 'Model is not priced' }, 400);
    if (provider.kind === 'api' && !config.pricing[model]) {
      return context.json({ error: 'Model is not priced' }, 400);
    }

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
      } else if (provider.kind === 'cli') {
        await cliRuntime.call(id, provider, buildCliInput([{ role: 'user', content: 'ping' }]));
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

  app.post('/api/providers/:id/restart', (context) => {
    const id = context.req.param('id');
    return options.serializeConfigWrite(async () => {
      const provider = options.getConfig().providers[id];
      if (!provider) return context.json({ error: 'Unknown provider' }, 404);
      if (provider.kind !== 'cli') return context.json({ error: 'Only CLI providers can restart' }, 400);
      if (!provider.prewarm) return context.json({ error: 'Only prewarmed CLI providers can restart' }, 400);
      cliRuntime.restart(id, provider);
      return context.json(cliRuntime.status(id));
    });
  });
}
