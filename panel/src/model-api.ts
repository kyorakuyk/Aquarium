import { apiRequest, type ModelProviderView } from './api.ts';

export type ModelParameterName = 'temperature' | 'maxTokens' | 'reasoning';
export type ModelCapability = 'supported' | 'unsupported' | 'unknown';
export type ModelCapabilitySource = 'advertised' | 'override' | 'unknown' | 'local';
export type ModelParameterOverride = Partial<Record<ModelParameterName, boolean>>;
export type ModelParameterOverrides = Record<string, ModelParameterOverride>;

export interface ProviderModelInfo {
  id: string;
  params: Record<ModelParameterName, ModelCapability>;
  sources: Record<ModelParameterName, Exclude<ModelCapabilitySource, 'local'>>;
}

export interface ProviderModelsView {
  models: ProviderModelInfo[];
  modelParams?: ModelParameterOverrides;
  fetchedAt?: number;
  cli?: boolean;
  error?: string;
}

export type ProviderModelsState =
  | { status: 'loading'; data?: ProviderModelsView }
  | { status: 'ready'; data: ProviderModelsView }
  | { status: 'error'; error: string; data?: ProviderModelsView };

export function modelParameterInfo(
  provider: ModelProviderView | undefined,
  modelId: string,
  parameter: ModelParameterName,
  data: ProviderModelsView | undefined,
): { capability: ModelCapability; source: ModelCapabilitySource; override?: boolean } {
  if (!provider || provider.kind === 'cli' || (parameter === 'reasoning' && provider.reasoningField === 'none')) {
    return { capability: 'unsupported', source: 'local' };
  }

  const model = data?.models.find((candidate) => candidate.id === modelId);
  const override = provider.modelParams !== undefined
    ? provider.modelParams[modelId]?.[parameter]
    : data?.modelParams?.[modelId]?.[parameter];
  const source = model?.sources[parameter] ?? (override === undefined ? 'unknown' : 'override');
  if (source === 'advertised' && model) {
    return { capability: model.params[parameter], source };
  }
  if (override !== undefined) {
    return { capability: override ? 'supported' : 'unsupported', source: 'override', override };
  }
  return { capability: 'unknown', source: 'unknown' };
}

export function getProviderModels(providerId: string, refresh = false): Promise<ProviderModelsView> {
  const suffix = refresh ? '?refresh=1' : '';
  return apiRequest<ProviderModelsView>(`/api/providers/${encodeURIComponent(providerId)}/models${suffix}`);
}
