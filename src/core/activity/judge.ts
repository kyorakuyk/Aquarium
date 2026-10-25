import type OpenAI from 'openai';
import { isBudgetExceededError } from '../../llm/budget.ts';
import type { JudgePromptTemplate } from '../prompt/templates.ts';

export interface JudgeContextMessage {
  time: number;
  senderName: string;
  isSelf: boolean;
  plainText: string;
}

export interface ParsedJudgeResponse {
  probability: number;
  reason: string;
}

export type JudgeResult =
  | { ok: true; probability: number; reason: string }
  | { ok: false; reason: 'judge_parse_error' | 'judge_error' | 'budget' };

export type JudgeSlotCall = (
  slot: 'judge',
  messages: OpenAI.ChatCompletionMessageParam[],
) => Promise<{ text: string }>;

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

export function buildJudgeMessages(
  context: readonly JudgeContextMessage[],
  template: JudgePromptTemplate,
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

export function parseJudgeResponse(text: string): ParsedJudgeResponse | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;

  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !Object.hasOwn(record, 'probability') || !Object.hasOwn(record, 'reason')) {
    return undefined;
  }
  if (typeof record.probability !== 'number'
    || !Number.isFinite(record.probability)
    || record.probability < 0
    || record.probability > 1
    || typeof record.reason !== 'string'
    || Array.from(record.reason).length > 20) {
    return undefined;
  }
  return { probability: record.probability, reason: record.reason };
}

export async function runJudge(
  context: readonly JudgeContextMessage[],
  template: JudgePromptTemplate,
  callModel: JudgeSlotCall,
): Promise<JudgeResult> {
  const messages = buildJudgeMessages(context, template);
  let response: { text: string };
  try {
    response = await callModel('judge', messages);
  } catch (error) {
    if (isBudgetExceededError(error)) return { ok: false, reason: 'budget' };
    return { ok: false, reason: 'judge_error' };
  }

  const parsed = parseJudgeResponse(response.text);
  if (!parsed) return { ok: false, reason: 'judge_parse_error' };
  return { ok: true, ...parsed };
}
