import type OpenAI from 'openai';
import type { MessageStorageRecord } from '../../store/repository.ts';
import type { ExtractPrivatePromptTemplate } from '../prompt-templates.ts';

export interface ExistingPrivateFactSummary {
  id: number;
  text: string;
  keywords: string[];
}

export interface ParsedPrivateFactResponse {
  new: unknown[];
  update: unknown[];
  obsolete: unknown[];
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function formatContext(records: readonly MessageStorageRecord[], ownerId: number): string {
  return records.slice(-60).map((record) => {
    const speaker = record.isSelf ? '眷属' : record.senderId === ownerId ? '对方' : '其他';
    return `[${formatTime(record.time)}] ${speaker}: ${record.plainText} #${record.messageId}`;
  }).join('\n');
}

function formatExisting(facts: readonly ExistingPrivateFactSummary[]): string {
  if (facts.length === 0) return '（暂无）';
  return facts.map((fact) => `#${fact.id} ${fact.text}（关键词：${fact.keywords.join('、')}）`).join('\n');
}

export function buildPrivateExtractionMessages(input: {
  records: readonly MessageStorageRecord[];
  ownerId: number;
  existing: readonly ExistingPrivateFactSummary[];
  template: ExtractPrivatePromptTemplate;
}): OpenAI.ChatCompletionMessageParam[] {
  return [
    { role: 'system', content: input.template.system },
    {
      role: 'user',
      content: input.template.user
        .replaceAll('{{context}}', formatContext(input.records, input.ownerId))
        .replaceAll('{{existing}}', formatExisting(input.existing)),
    },
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parsePrivateFactResponse(text: string): ParsedPrivateFactResponse | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || !Array.isArray(value.new)
    || !Array.isArray(value.update) || !Array.isArray(value.obsolete)) return undefined;
  return { new: value.new, update: value.update, obsolete: value.obsolete };
}
