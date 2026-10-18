import type { Hono } from 'hono';
import { z } from 'zod';
import type { AquariumConfig } from '../config/schema.ts';
import { readEnvKey } from './env-file.ts';

const CACHE_TTL_MS = 10 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const modelListSchema = z.object({
  data: z.array(z.object({
    id: z.string().min(1),
    supported_parameters: z.array(z.string()).optional(),
  })),
});

type ModelCapability = 'supported' | 'unsupported' | 'unknown';
type ApiProvider = Extract<AquariumConfig['providers'][string], { kind: 'api' }>;
type ProviderModel = z.infer<typeof modelListSchema>['data'][number];
interface ModelCacheEntry {
  baseUrl: string;
  apiKeyEnv: string;
  fetchedAt: number;
  models: ProviderModel[];
}

export interface ProviderModelRouteOptions {
  getConfig: () => AquariumConfig;
  envPath: string;
  env: NodeJS.ProcessEnv;
  now?: () => number;
  fetch?: typeof fetch;
}

function capability(value: boolean | undefined): ModelCapability {
  if (value === undefined) return 'unknown';
  return value ? 'supported' : 'unsupported';
}

function modelParams(model: ProviderModel, provider: ApiProvider): {
  temperature: ModelCapability;
  maxTokens: ModelCapability;
  reasoning: ModelCapability;
} {
  if (model.supported_parameters !== undefined) {
    const advertised = new Set(model.supported_parameters);
    return {
      temperature: advertised.has('temperature') ? 'supported' : 'unsupported',
      maxTokens: advertised.has('max_tokens') ? 'supported' : 'unsupported',
      reasoning: advertised.has('reasoning') || advertised.has('reasoning_effort') ? 'supported' : 'unsupported',
    };
  }

  const override = provider.modelParams?.[model.id];
  return {
    temperature: capability(override?.temperature),
    maxTokens: capability(override?.maxTokens),
    reasoning: capability(override?.reasoning),
  };
}

function modelListUrl(baseUrl: string): string | undefined {
  try {
    const url = new URL(baseUrl);
    url.username = '';
    url.password = '';
    url.pathname = `${url.pathname.replace(/\/+$/u, '')}/models`;
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

function apiKeyFor(provider: ApiProvider, options: ProviderModelRouteOptions): string | undefined {
  try {
    return readEnvKey(options.envPath, provider.apiKeyEnv) ?? options.env[provider.apiKeyEnv];
  } catch {
    return options.env[provider.apiKeyEnv];
  }
}

async function fetchModels(
  provider: ApiProvider,
  options: ProviderModelRouteOptions,
): Promise<{ models: ProviderModel[]; fetchedAt: number } | { error: string }> {
  const apiKey = apiKeyFor(provider, options);
  if (!apiKey) return { error: '未配置 API 密钥' };
  const url = modelListUrl(provider.baseUrl);
  if (!url) return { error: '模型列表地址无效' };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await (options.fetch ?? fetch)(url, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      return {
        error: response.status === 401 || response.status === 403
          ? `接入认证失败（HTTP ${response.status}）`
          : `模型列表请求失败（HTTP ${response.status}）`,
      };
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      return { error: '模型列表响应格式无效' };
    }
    const parsed = modelListSchema.safeParse(raw);
    if (!parsed.success) return { error: '模型列表响应格式无效' };
    return { models: parsed.data.data, fetchedAt: (options.now ?? Date.now)() };
  } catch {
    return { error: controller.signal.aborted ? '模型列表请求超时' : '无法连接到模型列表服务' };
  } finally {
    clearTimeout(timeout);
  }
}

export function registerProviderModelRoutes(app: Hono, options: ProviderModelRouteOptions): void {
  const cache = new Map<string, ModelCacheEntry>();
  const now = options.now ?? Date.now;

  app.get('/api/providers/:id/models', async (context) => {
    const id = context.req.param('id');
    const initialProvider = options.getConfig().providers[id];
    if (!initialProvider) return context.json({ error: 'Unknown provider' }, 404);
    if (initialProvider.kind === 'cli') return context.json({ models: [], cli: true });

    const refresh = context.req.query('refresh') === '1';
    let entry = cache.get(id);
    const ageMs = entry ? now() - entry.fetchedAt : Number.POSITIVE_INFINITY;
    const cacheMatches = entry?.baseUrl === initialProvider.baseUrl
      && entry.apiKeyEnv === initialProvider.apiKeyEnv;
    if (refresh || !entry || !cacheMatches || ageMs < 0 || ageMs >= CACHE_TTL_MS) {
      const result = await fetchModels(initialProvider, options);
      if ('error' in result) return context.json({ models: [], error: result.error });
      entry = {
        baseUrl: initialProvider.baseUrl,
        apiKeyEnv: initialProvider.apiKeyEnv,
        fetchedAt: result.fetchedAt,
        models: result.models,
      };
      cache.set(id, entry);
    }

    const currentProvider = options.getConfig().providers[id];
    if (!currentProvider) return context.json({ error: 'Unknown provider' }, 404);
    if (currentProvider.kind === 'cli') return context.json({ models: [], cli: true });
    if (currentProvider.baseUrl !== entry.baseUrl || currentProvider.apiKeyEnv !== entry.apiKeyEnv) {
      return context.json({ models: [], error: '接入配置已更改，请重试' });
    }

    return context.json({
      models: entry.models.map((model) => ({ id: model.id, params: modelParams(model, currentProvider) })),
      fetchedAt: entry.fetchedAt,
    });
  });
}
