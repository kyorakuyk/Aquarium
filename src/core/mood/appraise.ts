import type OpenAI from 'openai';
import { isBudgetExceededError } from '../../llm/budget.ts';
import type { AppraisePromptTemplate } from '../prompt/templates.ts';
import { MAX_AROUSAL_DELTA, MAX_DOMINANCE_DELTA, MAX_RESERVE_DELTA, MAX_VALENCE_DELTA } from './core.ts';

export interface AppraiseContextMessage {
  time: number;
  senderName: string;
  isSelf: boolean;
  plainText: string;
}

export interface ParsedAppraiseResponse {
  valence: number;
  reserve: number;
  arousal: number;
  dominance: number;
  causeTag: string;
  reason: string;
}

export type AppraiseResult =
  | { ok: true; valence: number; reserve: number; arousal: number; dominance: number; causeTag: string; reason: string }
  | { ok: false; reason: 'appraise_parse_error' | 'appraise_error' | 'budget' };

export type AppraiseSlotCall = (
  slot: 'extract',
  messages: OpenAI.ChatCompletionMessageParam[],
) => Promise<{ text: string }>;

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

export function buildAppraiseMessages(
  context: readonly AppraiseContextMessage[],
  template: AppraisePromptTemplate,
  innerVoice?: string,
): OpenAI.ChatCompletionMessageParam[] {
  const conversationText = context.slice(-8).map((message) => {
    const speaker = message.isSelf ? '你' : JSON.stringify(message.senderName);
    return `[${formatTime(message.time)}] ${speaker}: ${message.plainText}`;
  }).join('\n');
  const innerVoiceText = innerVoice?.trim()
    ? `${conversationText ? '\n\n' : ''}未说出口的心声（仅作为机器人情绪证据，不是对方说的话）：${JSON.stringify(innerVoice.trim())}`
    : '';
  const contextText = conversationText + innerVoiceText;
  const system = template.system
    .replaceAll('{{MAX_VALENCE_DELTA}}', String(MAX_VALENCE_DELTA))
    .replaceAll('{{MAX_RESERVE_DELTA}}', String(MAX_RESERVE_DELTA))
    .replaceAll('{{MAX_AROUSAL_DELTA}}', String(MAX_AROUSAL_DELTA))
    .replaceAll('{{MAX_DOMINANCE_DELTA}}', String(MAX_DOMINANCE_DELTA));

  return [
    { role: 'system', content: system },
    { role: 'user', content: template.user.replaceAll('{{context}}', contextText) },
  ];
}

// 严格解析：缺字段、越界或标签过长都视为解析失败。
export function parseAppraiseResponse(text: string): ParsedAppraiseResponse | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;

  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 6
    || !Object.hasOwn(record, 'valence')
    || !Object.hasOwn(record, 'reserve')
    || !Object.hasOwn(record, 'arousal')
    || !Object.hasOwn(record, 'dominance')
    || !Object.hasOwn(record, 'causeTag')
    || !Object.hasOwn(record, 'reason')) {
    return undefined;
  }
  const deltaInRange = (value: unknown, maximum: number): value is number => typeof value === 'number'
    && Number.isFinite(value)
    && value >= -maximum
    && value <= maximum;
  if (!deltaInRange(record.valence, MAX_VALENCE_DELTA)
    || !deltaInRange(record.reserve, MAX_RESERVE_DELTA)
    || !deltaInRange(record.arousal, MAX_AROUSAL_DELTA)
    || !deltaInRange(record.dominance, MAX_DOMINANCE_DELTA)) return undefined;
  if (typeof record.causeTag !== 'string' || record.causeTag.trim().length === 0
    || Array.from(record.causeTag).length > 20) return undefined;
  if (typeof record.reason !== 'string' || Array.from(record.reason).length > 20) return undefined;
  return {
    valence: record.valence,
    reserve: record.reserve,
    arousal: record.arousal,
    dominance: record.dominance,
    causeTag: record.causeTag,
    reason: record.reason,
  };
}

export async function runAppraise(
  context: readonly AppraiseContextMessage[],
  template: AppraisePromptTemplate,
  callModel: AppraiseSlotCall,
  innerVoice?: string,
): Promise<AppraiseResult> {
  const messages = buildAppraiseMessages(context, template, innerVoice);
  let response: { text: string };
  try {
    response = await callModel('extract', messages);
  } catch (error) {
    if (isBudgetExceededError(error)) return { ok: false, reason: 'budget' };
    return { ok: false, reason: 'appraise_error' };
  }

  const parsed = parseAppraiseResponse(response.text);
  if (!parsed) return { ok: false, reason: 'appraise_parse_error' };
  return { ok: true, ...parsed };
}
