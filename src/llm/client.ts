import OpenAI from 'openai';
import type { AquariumConfig } from '../config/schema.ts';

type ProviderSettings = AquariumConfig['providers'][string];
type ProviderClientFactory<TClient> = (name: string, provider: ProviderSettings) => TClient;

export interface ProviderClientRegistry<TClient> {
  get(config: AquariumConfig, name: string): TClient;
  clear(): void;
}

export function createProviderClientRegistry<TClient>(
  createClient: ProviderClientFactory<TClient>,
): ProviderClientRegistry<TClient> {
  const clients = new Map<string, { signature: string; client: TClient }>();

  return {
    get(config, name) {
      const provider = config.providers[name];
      if (!provider) throw new Error(`未配置模型服务商：${name}`);
      const signature = `${provider.baseUrl}\u0000${provider.apiKeyEnv}`;
      const cached = clients.get(name);
      if (cached?.signature === signature) return cached.client;

      const client = createClient(name, provider);
      clients.set(name, { signature, client });
      return client;
    },
    clear() {
      clients.clear();
    },
  };
}

export function createOpenAIClient(
  provider: ProviderSettings,
  env: NodeJS.ProcessEnv = process.env,
): OpenAI {
  const apiKey = env[provider.apiKeyEnv];
  if (!apiKey) throw new Error(`缺少模型服务商所需环境变量：${provider.apiKeyEnv}`);

  return new OpenAI({
    baseURL: provider.baseUrl,
    apiKey,
    timeout: 30_000,
    maxRetries: 0,
  });
}

const providerClients = createProviderClientRegistry(
  (_name, provider) => createOpenAIClient(provider),
);

export function getProviderClient(config: AquariumConfig, name: string): OpenAI {
  return providerClients.get(config, name);
}
