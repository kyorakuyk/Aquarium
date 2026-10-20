import type OpenAI from 'openai';
import type { AppraisePromptTemplate } from '../prompt/templates.ts';

export interface AppraiseContextMessage {
  time: number;
  senderName: string;
  isSelf: boolean;
  plainText: string;
}

export interface ParsedAppraiseResponse {
  valence: number;
  arousal: number;
  reason: string;
}

export type AppraiseResult =
  | { ok: true; valence: number; arousal: number; reason: string }
  | { ok: false; reason: 'appraise_parse_error' | 'appraise_error' };

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
): OpenAI.ChatCompletionMessageParam[] {
  const contextText = context.slice(-8).map((message) => {
    const speaker = message.isSelf ? '你' : JSON.stringify(message.senderName);
    return `[${formatTime(message.time)}] ${speaker}: ${message.plainText}`;
  }).join('\n');

  return [
    { role: 'system', content: template.system },
    { role: 'user', content: template.user.replaceAll('{{context}}', contextText) },
  ];
}

// 严格解析：缺字段、越界或超长 reason 都视为解析失败。
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
  if (keys.length !== 3
    || !Object.hasOwn(record, 'valence')
    || !Object.hasOwn(record, 'arousal')
    || !Object.hasOwn(record, 'reason')) {
    return undefined;
  }
  const deltaInRange = (value: unknown): value is number => typeof value === 'number'
    && Number.isFinite(value)
    && value >= -0.15
    && value <= 0.15;
  if (!deltaInRange(record.valence) || !deltaInRange(record.arousal)) return undefined;
  if (typeof record.reason !== 'string' || Array.from(record.reason).length > 20) return undefined;
  return { valence: record.valence, arousal: record.arousal, reason: record.reason };
}

export async function runAppraise(
  context: readonly AppraiseContextMessage[],
  template: AppraisePromptTemplate,
  callModel: AppraiseSlotCall,
): Promise<AppraiseResult> {
  const messages = buildAppraiseMessages(context, template);
  let response: { text: string };
  try {
    response = await callModel('extract', messages);
  } catch {
    return { ok: false, reason: 'appraise_error' };
  }

  const parsed = parseAppraiseResponse(response.text);
  if (!parsed) return { ok: false, reason: 'appraise_parse_error' };
  return { ok: true, ...parsed };
}
