import type OpenAI from 'openai';
import type { ProtocolAdapter } from '../../adapters/types.ts';
import type { AquariumConfig, SessionSettings } from '../../config/schema.ts';
import type { ImageDownloader } from '../images.ts';
import type { IncomingMessage, Segment, SessionKey } from '../events.ts';
import type { RateLimiter } from '../rate-limit.ts';
import type { SlotCallOptions, SlotResult } from '../../llm/slots.ts';
import type { StoreRepository } from '../../store/repository.ts';
import type { PromptTemplateSet } from '../prompt-templates.ts';
import type { PromptBlockHash } from '../prompt.ts';
import type { ActivityBatch } from '../activity/batcher.ts';
import type { IdleBackoff } from '../activity/backoff.ts';
import type { ActivityThreshold, ProactiveMode } from '../activity/threshold.ts';
import type { MoodService } from '../mood/service.ts';
import type { ImpressionsService } from '../impressions/service.ts';

export interface PipelineResult {
  replied: boolean;
  reason: string;
  replay?: ReplayOutcome;
}

export interface ReplayOutcome {
  wouldReply: boolean;
  reason: string;
  replyText: string;
  trace: TraceEntry[];
  provider?: string;
  model?: string;
  replyCostCny?: number;
  totalCostCny?: number;
  parts?: string[];
}

export interface ProcessMessageOptions {
  alreadySaved?: boolean;
  replay?: boolean;
  batched?: boolean;
  activityBatch?: ActivityBatch<IncomingMessage>;
}

export type PipelineModelCall = (
  slot: string,
  messages: OpenAI.ChatCompletionMessageParam[],
  options: SlotCallOptions,
) => Promise<SlotResult>;

export interface MessagePipelineOptions {
  getConfig: () => AquariumConfig;
  repository: StoreRepository;
  adapter: ProtocolAdapter;
  getNickname: () => string;
  callModel?: PipelineModelCall;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  personaRoot?: string;
  getPromptTemplates?: () => PromptTemplateSet;
  downloadImage?: ImageDownloader;
  isMuted?: (session: SessionKey) => boolean;
  idleBackoff?: IdleBackoff;
  activityThreshold?: ActivityThreshold;
  moodService?: MoodService;
  impressionsService?: ImpressionsService;
  onError?: (error: unknown, message: IncomingMessage) => void;
}

export type PipelineStepName = 'persist' | 'gate' | 'context' | 'generate' | 'deliver';

export interface TraceEntry {
  step: PipelineStepName;
  startedAt: number;
  durationMs: number;
  summary: string;
}

export type StepResult =
  | { next: true; detail?: unknown }
  | { next: false; reason: string; detail?: unknown; replied?: boolean };

export interface PipelineState {
  config?: AquariumConfig;
  settings?: SessionSettings;
  nickname?: string;
  persona?: string;
  callOptions?: SlotCallOptions;
  prompt?: OpenAI.ChatCompletionMessageParam[];
  promptBlocks?: PromptBlockHash[];
  droppedTags?: number;
  result?: SlotResult;
  replyText?: string;
  parts?: string[];
  sentMessageIds: string[];
  promptHash?: string;
  replayReplyCostCny?: number;
  replayTotalCostCny?: number;
  activityDecisionDetail?: Record<string, unknown>;
  proactiveMode?: ProactiveMode;
  promptFingerprints: PromptFingerprint[];
  promptTemplates: PromptTemplateSet;
}

export interface PromptFingerprint {
  slot: string;
  templateVersion: string;
  promptHash: string;
}

export interface StepContext {
  message: IncomingMessage;
  processOptions: ProcessMessageOptions;
  currentSessionId: string;
  options: MessagePipelineOptions;
  now: () => number;
  wait: (milliseconds: number) => Promise<void>;
  random: () => number;
  modelCall: PipelineModelCall;
  rateLimiter: RateLimiter;
  trace: TraceEntry[];
  state: PipelineState;
}

export type PipelineStep = (ctx: StepContext) => Promise<StepResult>;

const safeTraceReasons: Record<PipelineStepName, readonly string[]> = {
  persist: ['duplicate'],
  gate: [
    'muted', 'disabled', 'not_mentioned', 'mode_mention_only', 'rate_limited',
    'budget', 'batched', 'backoff', 'prefilter', 'judge_parse_error', 'judge_error',
    'judge_skip', 'proactive_cooldown',
  ],
  context: ['persona_error'],
  generate: ['llm_error', 'empty_reply'],
  deliver: ['send_error', 'replied', 'replay'],
};

export function boundedTraceSummary(value: string): string {
  return Array.from(value).slice(0, 500).join('');
}

function traceSummary(step: PipelineStepName, result: StepResult): string {
  const reason = result.next
    ? 'next'
    : safeTraceReasons[step].includes(result.reason) ? result.reason : 'stopped';
  if (step !== 'gate' || !result.detail || typeof result.detail !== 'object' || Array.isArray(result.detail)) {
    return boundedTraceSummary(reason);
  }

  const detail = result.detail as Record<string, unknown>;
  const summaryParts = [reason];
  if (detail.trigger === 'proactive') summaryParts.push('trigger=proactive');
  for (const key of ['batchSize', 'p0', 'probability', 'threshold'] as const) {
    const value = detail[key];
    if (typeof value === 'number' && Number.isFinite(value)) summaryParts.push(`${key}=${value}`);
  }
  if (detail.backoff === 'clear' || detail.backoff === 'waiting' || detail.backoff === 'bypassed') {
    summaryParts.push(`backoff=${detail.backoff}`);
  }
  return boundedTraceSummary(summaryParts.join(' '));
}

export async function traceStep(
  ctx: StepContext,
  step: PipelineStepName,
  run: () => Promise<StepResult>,
): Promise<StepResult> {
  const startedAt = Date.now();
  const started = performance.now();
  let summary = 'error';
  try {
    const result = await run();
    summary = traceSummary(step, result);
    return result;
  } finally {
    ctx.trace.push({
      step,
      startedAt,
      durationMs: Math.max(0, performance.now() - started),
      summary,
    });
  }
}

export function messageRecord(message: IncomingMessage, currentSessionId: string) {
  return {
    sessionId: currentSessionId,
    messageId: message.messageId,
    senderId: message.senderId,
    senderName: message.senderName,
    isSelf: false,
    plainText: message.plainText,
    segments: message.segments as Segment[],
    time: message.time,
  };
}
