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
import type { AffinityService } from '../affinity/service.ts';
import type { ImpressionsService } from '../impressions/service.ts';
import type { PrivateFactsService } from '../privacy/service.ts';
import type { PrivacyGateDecision, PrivacyGateDetail, PrivacyGateService } from '../privacy/group-gate.ts';
import type { PersonaTraits } from '../../persona/load.ts';
import type { SleepWakeState } from '../sleep.ts';
import type { StickerService } from '../stickers/service.ts';
import type { StickerOffer } from '../stickers/selection.ts';

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
  quoteReplyTo?: boolean;
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
  affinityService?: AffinityService;
  impressionsService?: ImpressionsService;
  privateFactsService?: PrivateFactsService;
  privacyGateService?: PrivacyGateService;
  stickerService?: StickerService;
  sleepWakeState?: SleepWakeState;
  onError?: (error: unknown, message: IncomingMessage) => void;
}

export type PipelineStepName = 'persist' | 'gate' | 'context' | 'generate' | 'deliver';

export interface TraceEntry {
  step: PipelineStepName;
  startedAt: number;
  durationMs: number;
  summary: string;
  detail?: unknown;
}

export type StepResult =
  | { next: true; detail?: unknown }
  | { next: false; reason: string; detail?: unknown; replied?: boolean };

export interface PipelineState {
  config?: AquariumConfig;
  settings?: SessionSettings;
  nickname?: string;
  persona?: string;
  personaTraits?: PersonaTraits;
  callOptions?: SlotCallOptions;
  prompt?: OpenAI.ChatCompletionMessageParam[];
  promptBlocks?: PromptBlockHash[];
  injectedAffectBlocks?: {
    mood?: string;
    float?: string;
    affinity?: string;
  };
  droppedTags?: number;
  privacyPromptBlocks?: Pick<PrivacyGateDecision, 'knownFacts' | 'privateRule'>;
  privacyDecisionDetail?: PrivacyGateDetail;
  suppressSensitiveDebugTrace?: boolean;
  result?: SlotResult;
  replyText?: string;
  parts?: string[];
  sentMessageIds: string[];
  promptHash?: string;
  replayReplyCostCny?: number;
  replayTotalCostCny?: number;
  activityDecisionDetail?: Record<string, unknown>;
  energy?: number;
  proactiveMode?: ProactiveMode;
  stickerOffer?: StickerOffer;
  stickerOffered?: number[];
  chosenSticker?: StickerOffer['candidates'][number];
  stickerOnly?: boolean;
  stickerSent?: { id: number; stickerOnly: boolean };
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
    'budget', 'batched', 'backoff', 'asleep', 'persona_error', 'prefilter', 'judge_parse_error', 'judge_error',
    'judge_skip', 'proactive_cooldown', 'privacy_avoid',
  ],
  context: ['persona_error'],
  generate: ['llm_error', 'empty_reply', 'sticker_only_capped'],
  deliver: ['send_error', 'replied', 'replay', 'privacy_egress'],
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

function generateTraceDetail(detail: unknown): { params: Record<string, number | string> } | undefined {
  if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) return undefined;
  const rawParams = (detail as Record<string, unknown>).params;
  if (typeof rawParams !== 'object' || rawParams === null || Array.isArray(rawParams)) return undefined;
  const params = rawParams as Record<string, unknown>;
  const safeParams: Record<string, number | string> = {};
  if (typeof params.temperature === 'number' && Number.isFinite(params.temperature)
    && params.temperature >= 0 && params.temperature <= 2) {
    safeParams.temperature = params.temperature;
  }
  if (Number.isSafeInteger(params.maxTokens) && typeof params.maxTokens === 'number' && params.maxTokens > 0) {
    safeParams.maxTokens = params.maxTokens;
  }
  if (params.reasoning === 'low' || params.reasoning === 'medium' || params.reasoning === 'high') {
    safeParams.reasoning = params.reasoning;
  }
  return { params: safeParams };
}

function privacyTraceDetail(detail: unknown): Record<string, unknown> | undefined {
  if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) return undefined;
  const privacy = (detail as Record<string, unknown>).privacy;
  if (typeof privacy !== 'object' || privacy === null || Array.isArray(privacy)) return undefined;
  const source = privacy as Record<string, unknown>;
  const factRefs = (value: unknown): Array<{ id: number; level: string }> => {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) return [];
      const ref = item as Record<string, unknown>;
      if (typeof ref.id !== 'number' || !Number.isSafeInteger(ref.id) || ref.id <= 0
        || !['L0', 'L1', 'L2'].includes(String(ref.level))) return [];
      return [{ id: ref.id, level: String(ref.level) }];
    });
  };
  const safe: Record<string, unknown> = {
    prefiltered: factRefs(source.prefiltered),
    touched: factRefs(source.touched),
    injected: factRefs(source.injected),
    judge: ['skipped', 'judged', 'fallback_all'].includes(String(source.judge)) ? source.judge : 'skipped',
  };
  if (typeof source.avoidUntil === 'number' && Number.isFinite(source.avoidUntil)) safe.avoidUntil = source.avoidUntil;
  return { privacy: safe };
}

function egressTraceDetail(detail: unknown): Record<string, unknown> | undefined {
  if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) return undefined;
  const egress = (detail as Record<string, unknown>).privacyEgress;
  if (typeof egress !== 'object' || egress === null || Array.isArray(egress)) return undefined;
  const factId = (egress as Record<string, unknown>).id;
  return {
    privacyEgress: {
      ...(typeof factId === 'number' && Number.isSafeInteger(factId) && factId > 0 ? { id: factId } : {}),
      level: 'L0',
    },
  };
}

export async function traceStep(
  ctx: StepContext,
  step: PipelineStepName,
  run: () => Promise<StepResult>,
): Promise<StepResult> {
  const startedAt = Date.now();
  const started = performance.now();
  let summary = 'error';
  let detail: unknown;
  try {
    const result = await run();
    summary = traceSummary(step, result);
    if (step === 'context') detail = contextTraceDetail(result.detail);
    if (step === 'generate') detail = generateTraceDetail(result.detail);
    if (step === 'gate') detail = privacyTraceDetail(result.detail);
    if (step === 'deliver') detail = egressTraceDetail(result.detail);
    return result;
  } finally {
    ctx.trace.push({
      step,
      startedAt,
      durationMs: Math.max(0, performance.now() - started),
      summary,
      ...(detail !== undefined ? { detail } : {}),
    });
  }
}

function contextTraceDetail(detail: unknown): { injectedAffectBlocks: NonNullable<PipelineState['injectedAffectBlocks']> } | undefined {
  if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) return undefined;
  const rawBlocks = (detail as Record<string, unknown>).injectedAffectBlocks;
  if (typeof rawBlocks !== 'object' || rawBlocks === null || Array.isArray(rawBlocks)) return undefined;
  const source = rawBlocks as Record<string, unknown>;
  const blocks: NonNullable<PipelineState['injectedAffectBlocks']> = {};
  for (const key of ['mood', 'float', 'affinity'] as const) {
    if (typeof source[key] === 'string' && source[key]) blocks[key] = source[key];
  }
  return Object.keys(blocks).length > 0 ? { injectedAffectBlocks: blocks } : undefined;
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
