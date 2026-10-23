import type OpenAI from 'openai';
import type { PrivateGroupEventCandidate } from '../impressions/group-events-prompt.ts';
import { redactSensitiveText } from '../impressions/sensitive-text.ts';
import type { MessageStorageRecord } from '../../store/repository.ts';
import type { ExtractPrivatePromptTemplate } from '../prompt/templates.ts';

export interface ExistingPrivateFactSummary {
  id: number;
  text: string;
  keywords: string[];
}

export interface ParsedPrivateFactResponse {
  new: unknown[];
  update: unknown[];
  obsolete: unknown[];
  eventNotes: unknown[];
}

export interface ExistingEventNoteSummary {
  eventId: number;
  text: string;
  intent: 'confide' | 'clarify' | 'advocate';
  level: 'L0' | 'L1' | 'L2';
  status: 'active' | 'retracted';
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function serializePromptData(value: unknown): string {
  const slash = String.fromCharCode(92);
  return JSON.stringify(value)
    .replaceAll('&', `${slash}u0026`)
    .replaceAll('<', `${slash}u003c`)
    .replaceAll('>', `${slash}u003e`);
}

function formatContext(records: readonly MessageStorageRecord[], ownerId: number): string {
  return serializePromptData(records.slice(-60).map((record) => ({
    time: formatTime(record.time),
    speaker: record.isSelf ? '眷属' : record.senderId === ownerId ? '对方' : '其他',
    messageId: `#${record.messageId}`,
    text: record.plainText,
  })));
}

function formatExisting(facts: readonly ExistingPrivateFactSummary[]): string {
  return serializePromptData(facts.map(({ id, text, keywords }) => ({ id, text, keywords })));
}

function formatEvents(
  events: readonly PrivateGroupEventCandidate[],
  notes: readonly ExistingEventNoteSummary[],
): string {
  return serializePromptData({
    candidates: events.map((event) => ({
      eventId: event.id,
      time: event.occurredAt,
      title: redactSensitiveText(event.title),
      summary: redactSensitiveText(event.summary),
    })),
    existingNotes: notes.map((note) => ({
      eventId: note.eventId,
      text: redactSensitiveText(note.text),
      intent: note.intent,
      level: note.level,
      status: note.status,
    })),
  });
}

export function buildPrivateExtractionMessages(input: {
  records: readonly MessageStorageRecord[];
  ownerId: number;
  existing: readonly ExistingPrivateFactSummary[];
  events?: readonly PrivateGroupEventCandidate[];
  existingEventNotes?: readonly ExistingEventNoteSummary[];
  template: ExtractPrivatePromptTemplate;
}): OpenAI.ChatCompletionMessageParam[] {
  return [
    { role: 'system', content: input.template.system },
    {
      role: 'user',
      content: input.template.user.replace(/\{\{context\}\}|\{\{existing\}\}|\{\{events\}\}/gu, (placeholder) => {
        if (placeholder === '{{context}}') return formatContext(input.records, input.ownerId);
        if (placeholder === '{{existing}}') return formatExisting(input.existing);
        return formatEvents(input.events ?? [], input.existingEventNotes ?? []);
      }),
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
  return {
    new: value.new,
    update: value.update,
    obsolete: value.obsolete,
    eventNotes: Array.isArray(value.eventNotes) ? value.eventNotes : [],
  };
}
