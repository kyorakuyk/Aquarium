import { createHash } from 'node:crypto';
import OpenAI from 'openai';
import type { AquariumConfig } from '../config/schema.ts';
import { getProviderClient } from './client.ts';
import {
  BudgetExceededError,
  filterNonBillableEntries,
  type BudgetScope,
} from './budget.ts';
import { buildCliInput, getCliRuntime, type CliRuntime } from './cli.ts';

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
  account: number | null;
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
  account: number | null;
  costToday: () => number;
  budgetScope?: BudgetScope;
  oneoffTaskCostCny?: () => number;
  recordUsage: (usage: UsageAttempt) => void;
  getClient?: (provider: string) => OpenAI;
  now?: () => number;
  timeoutMs?: number;
  cliRuntime?: CliRuntime;
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

export interface SlotRequestParams {
  temperature?: number;
  maxTokens?: number;
  reasoning?: 'low' | 'medium' | 'high';
}

export interface SlotResult {
  text: string;
  provider: string;
  model: string;
  usage: SlotUsage;
  params?: SlotRequestParams;
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
  const details = error as {
    name?: unknown;
    status?: unknown;
    constructor?: { name?: unknown };
    cause?: unknown;
  };
  const cause = details.cause && typeof details.cause === 'object'
    ? details.cause as { code?: unknown }
    : undefined;
  return {
    errorName: typeof details.name === 'string' ? details.name : 'Error',
    ...(typeof details.status === 'number' ? { status: details.status } : {}),
    ...(typeof details.constructor?.name === 'string'
      ? { errorConstructorName: details.constructor.name }
      : {}),
    ...(typeof cause?.code === 'string' ? { causeCode: cause.code } : {}),
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
  const budgetScope = options.budgetScope ?? (slot === 'oneoff' ? 'oneoff' : 'daily');
  const usedCny = budgetScope === 'daily'
    ? options.costToday()
    : options.oneoffTaskCostCny?.();
  if (usedCny === undefined) throw new TypeError('oneoff 预算范围必须提供当前任务累计费用');
  if (!Number.isFinite(usedCny) || usedCny < 0) throw new RangeError('预算累计费用必须是非负有限数');
  const limitCny = budgetScope === 'daily'
    ? options.config.budget.dailyCny
    : options.config.budget.oneoffTaskCny;
  const exceeded = usedCny >= limitCny;
  if (exceeded && budgetScope === 'oneoff') throw new BudgetExceededError(slot, budgetScope, usedCny, limitCny);
  const chain = exceeded ? filterNonBillableEntries(options.config, slot) : configuredChain;
  if (chain.length === 0) throw new BudgetExceededError(slot, budgetScope, usedCny, limitCny);
  const usageSlot = budgetScope === 'oneoff' ? 'oneoff' : slot;
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
  let lastError: unknown;

  for (let index = 0; index < chain.length; index += 1) {
    const entry = chain[index];
    if (!entry) continue;
    const provider = options.config.providers[entry.provider];
    if (!provider) throw new Error(`未配置模型服务商：${entry.provider}`);
    const price = options.config.pricing[entry.model];
    if (provider.kind === 'api' && !price) {
      throw new Error(`模型 ${entry.model} 缺少价格配置，拒绝发送请求`);
    }
    const timeoutMs = entry.timeoutSec !== undefined
      ? entry.timeoutSec * 1_000
      : options.timeoutMs ?? (slot === 'extract' ? 90_000 : 30_000);
    const sentParams: SlotRequestParams = provider.kind === 'api' ? {
      ...(entry.temperature !== undefined ? { temperature: entry.temperature } : {}),
      ...(entry.maxTokens !== undefined ? { maxTokens: entry.maxTokens } : {}),
      ...(entry.reasoning !== 'off' && provider.reasoningField !== 'none'
        ? { reasoning: entry.reasoning }
        : {}),
    } : {};
    const requestBody = {
      model: entry.model,
      messages,
      ...(sentParams.temperature !== undefined ? { temperature: sentParams.temperature } : {}),
      ...(sentParams.maxTokens !== undefined ? { max_tokens: sentParams.maxTokens } : {}),
      ...(sentParams.reasoning !== undefined && provider.kind === 'api'
        ? { [provider.reasoningField]: sentParams.reasoning }
        : {}),
    } as OpenAI.ChatCompletionCreateParamsNonStreaming;

    let response: OpenAI.ChatCompletion | undefined;
    let cliText: string | undefined;
    let attemptError: unknown;
    let failed = false;
    let completedAt = 0;
    let latencyMs = 0;
    let networkRetryUsed = false;
    while (true) {
      const startedAt = now();
      response = undefined;
      cliText = undefined;
      attemptError = undefined;
      failed = false;
      try {
        if (provider.kind === 'cli') {
          cliText = await (options.cliRuntime ?? getCliRuntime()).call(
            entry.provider,
            provider,
            buildCliInput(messages),
            timeoutMs,
          );
        } else {
          const client = options.getClient
            ? options.getClient(entry.provider)
            : getProviderClient(options.config, entry.provider);
          response = await client.chat.completions.create(requestBody, { timeout: timeoutMs, maxRetries: 0 });
        }
      } catch (error) {
        failed = true;
        attemptError = error;
      }

      completedAt = now();
      latencyMs = Math.max(0, completedAt - startedAt);
      if (!failed) break;

      options.recordUsage({
        time: completedAt,
        account: options.account,
        slot: usageSlot,
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

      const networkFailure = failureStatus(attemptError) === undefined && canFallback(attemptError);
      if (slot === 'reply'
        && configuredChain.length === 1
        && provider.kind === 'api'
        && !networkRetryUsed
        && networkFailure) {
        networkRetryUsed = true;
        await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
        continue;
      }

      if ((provider.kind === 'api' && !canFallback(attemptError)) || index === chain.length - 1) {
        throw attemptError;
      }
      break;
    }
    if (failed) continue;

    if (provider.kind === 'api' && !response) throw new Error(`模型 ${entry.model} 没有返回结果`);
    const responseText = provider.kind === 'cli'
      ? cliText ?? ''
      : typeof response?.choices[0]?.message.content === 'string'
        ? response.choices[0].message.content
        : '';
    const usage = response?.usage;
    const inputTokens = tokenCount(usage?.prompt_tokens);
    const outputTokens = tokenCount(usage?.completion_tokens);
    const extendedUsage = usage as (typeof usage & {
      prompt_cache_hit_tokens?: unknown;
    }) | null | undefined;
    const cachedValue = extendedUsage?.prompt_cache_hit_tokens
      ?? usage?.prompt_tokens_details?.cached_tokens;
    const cachedTokens = Math.min(inputTokens, tokenCount(cachedValue));
    const costCny = provider.kind === 'cli' || !price
      ? 0
      : (
        (inputTokens - cachedTokens) * price.input
        + cachedTokens * price.cachedInput
        + outputTokens * price.output
      ) / 1_000_000;
    const slotUsage = { inputTokens, cachedTokens, outputTokens, costCny };

    options.recordUsage({
      time: completedAt,
      account: options.account,
      slot: usageSlot,
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
      params: sentParams,
    };
  }

  throw lastError ?? new Error(`模型槽位 ${slot} 的降级链没有可用项`);
}
