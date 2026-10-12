import { createHash } from 'node:crypto';
import OpenAI from 'openai';
import type { AquariumConfig } from '../config/schema.ts';
import { getProviderClient } from './client.ts';
import { budgetState } from './budget.ts';

const retryableNetworkCodes = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
]);

export interface UsageAttempt {
  time: number;
  slot: string;
  provider: string;
  model: string;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  costCny: number;
  latencyMs: number;
  ok: boolean;
}

export interface SlotCallOptions {
  config: AquariumConfig;
  costToday: () => number;
  recordUsage: (usage: UsageAttempt) => void;
  getClient?: (provider: string) => OpenAI;
  now?: () => number;
  timeoutMs?: number;
  debugTrace?: SlotDebugTraceContext;
}

export interface SlotDebugTraceContext {
  sessionId: string;
  messageId: string;
  record: (trace: SlotDebugTraceRecord) => void;
  onPromptHash: (hash: string) => void;
  onError?: (error: unknown) => void;
}

export interface SlotDebugTraceRecord {
  time: number;
  sessionId: string;
  messageId: string;
  slot: string;
  provider: string;
  model: string;
  promptJson: string;
  responseText: string;
  promptHash: string;
  detail: unknown;
}

export interface SlotUsage {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  costCny: number;
}

export interface SlotResult {
  text: string;
  provider: string;
  model: string;
  usage: SlotUsage;
}

function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function failureStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

function canFallback(error: unknown): boolean {
  const status = failureStatus(error);
  if (status !== undefined) return status === 408 || status === 429 || (status >= 500 && status < 600);
  if (error instanceof TypeError) return true;
  if (!error || typeof error !== 'object') return false;

  const details = error as { name?: unknown; code?: unknown };
  if (details.name === 'APIConnectionError'
    || details.name === 'APIConnectionTimeoutError'
    || details.name === 'TimeoutError') return true;

  return typeof details.code === 'string' && retryableNetworkCodes.has(details.code);
}

function debugErrorDetails(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== 'object') return { errorName: 'UnknownError' };
  const details = error as { name?: unknown; status?: unknown };
  return {
    errorName: typeof details.name === 'string' ? details.name : 'Error',
    ...(typeof details.status === 'number' ? { status: details.status } : {}),
  };
}

function recordDebugTrace(
  context: SlotDebugTraceContext | undefined,
  promptJson: string | undefined,
  promptHash: string | undefined,
  trace: Omit<SlotDebugTraceRecord, 'sessionId' | 'messageId' | 'promptJson' | 'promptHash'>,
): void {
  if (!context || promptJson === undefined || promptHash === undefined) return;
  try {
    context.record({
      ...trace,
      sessionId: context.sessionId,
      messageId: context.messageId,
      promptJson,
      promptHash,
    });
  } catch (error) {
    try {
      context.onError?.(error);
    } catch {
      // 调试存储失败不能影响模型回复。
    }
  }
}

export async function callSlot(
  slot: string,
  messages: OpenAI.ChatCompletionMessageParam[],
  options: SlotCallOptions,
): Promise<SlotResult> {
  const configuredChain = options.config.slots[slot];
  if (!configuredChain?.length) throw new Error(`模型槽位不存在或没有降级项：${slot}`);
  const lastConfiguredEntry = configuredChain[configuredChain.length - 1];
  const chain = slot === 'reply'
    && budgetState(options.config, options.costToday()) === 'exceeded'
    && lastConfiguredEntry
    ? [lastConfiguredEntry]
    : configuredChain;
  const now = options.now ?? Date.now;
  const promptJson = options.debugTrace ? JSON.stringify(messages) : undefined;
  const promptHash = promptJson === undefined
    ? undefined
    : createHash('sha256').update(promptJson).digest('hex').slice(0, 16);
  if (promptHash && options.debugTrace) {
    try {
      options.debugTrace.onPromptHash(promptHash);
    } catch (error) {
      try {
        options.debugTrace.onError?.(error);
      } catch {
        // 调试回调失败不能影响模型调用。
      }
    }
  }
  const timeoutMs = options.timeoutMs ?? 30_000;
  let lastError: unknown;

  for (let index = 0; index < chain.length; index += 1) {
    const entry = chain[index];
    if (!entry) continue;
    const price = options.config.pricing[entry.model];
    if (!price) throw new Error(`模型 ${entry.model} 缺少价格配置，拒绝发送请求`);

    const startedAt = now();
    let response: OpenAI.ChatCompletion | undefined;
    let attemptError: unknown;
    let failed = false;
    try {
      const client = options.getClient
        ? options.getClient(entry.provider)
        : getProviderClient(options.config, entry.provider);
      response = await client.chat.completions.create(
        { model: entry.model, messages },
        { timeout: timeoutMs, maxRetries: 0 },
      );
    } catch (error) {
      failed = true;
      attemptError = error;
    }

    const completedAt = now();
    const latencyMs = Math.max(0, completedAt - startedAt);
    if (failed) {
      options.recordUsage({
        time: completedAt,
        slot,
        provider: entry.provider,
        model: entry.model,
        inputTokens: 0,
        cachedTokens: 0,
        outputTokens: 0,
        costCny: 0,
        latencyMs,
        ok: false,
      });
      recordDebugTrace(options.debugTrace, promptJson, promptHash, {
        time: completedAt,
        slot,
        provider: entry.provider,
        model: entry.model,
        responseText: '',
        detail: debugErrorDetails(attemptError),
      });
      lastError = attemptError;
      if (!canFallback(attemptError) || index === chain.length - 1) throw attemptError;
      continue;
    }

    if (!response) throw new Error(`模型 ${entry.model} 没有返回结果`);
    const responseText = typeof response.choices[0]?.message.content === 'string'
      ? response.choices[0].message.content
      : '';
    const usage = response.usage;
    const inputTokens = tokenCount(usage?.prompt_tokens);
    const outputTokens = tokenCount(usage?.completion_tokens);
    const extendedUsage = usage as (typeof usage & {
      prompt_cache_hit_tokens?: unknown;
    }) | null | undefined;
    const cachedValue = extendedUsage?.prompt_cache_hit_tokens
      ?? usage?.prompt_tokens_details?.cached_tokens;
    const cachedTokens = Math.min(inputTokens, tokenCount(cachedValue));
    const costCny = (
      (inputTokens - cachedTokens) * price.input
      + cachedTokens * price.cachedInput
      + outputTokens * price.output
    ) / 1_000_000;
    const slotUsage = { inputTokens, cachedTokens, outputTokens, costCny };

    options.recordUsage({
      time: completedAt,
      slot,
      provider: entry.provider,
      model: entry.model,
      ...slotUsage,
      latencyMs,
      ok: true,
    });
    recordDebugTrace(options.debugTrace, promptJson, promptHash, {
      time: completedAt,
      slot,
      provider: entry.provider,
      model: entry.model,
      responseText,
      detail: {},
    });

    return {
      text: responseText,
      provider: entry.provider,
      model: entry.model,
      usage: slotUsage,
    };
  }

  throw lastError ?? new Error(`模型槽位 ${slot} 的降级链没有可用项`);
}
