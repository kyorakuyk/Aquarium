import type OpenAI from 'openai';
import type { StoredTag } from '../../store/affect-repo.ts';
import type { MessageStorageRecord } from '../../store/repository.ts';
import type { ExtractTagsPromptTemplate } from '../prompt-templates.ts';

export interface ExtractObserveItem {
  id: number;
  messageId: string;
}

export interface ExtractNewItem {
  text: string;
  messageId: string;
}

export interface ExtractContradictItem {
  id: number;
  text: string;
  messageId: string;
}

export interface ExtractSubjectItems {
  observe: unknown[];
  new: unknown[];
  contradict: unknown[];
}

export interface ExtractMemberItems extends ExtractSubjectItems {
  userId: number;
}

export interface ParsedExtractResponse {
  group: ExtractSubjectItems;
  members: ExtractMemberItems[];
}

export type ExtractResult =
  | { ok: true; parsed: ParsedExtractResponse }
  | { ok: false; reason: 'extract_parse_error' | 'extract_error' };

export type ExtractSlotCall = (
  slot: 'extract',
  messages: OpenAI.ChatCompletionMessageParam[],
) => Promise<{ text: string }>;

export interface ExistingTagsInput {
  group: StoredTag[];
  members: Array<{ userId: number; tags: StoredTag[] }>;
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function formatExistingTags(existing: ExistingTagsInput): string {
  const lines: string[] = [];
  if (existing.group.length > 0) {
    lines.push(`群标签：${existing.group.map((tag) => `#${tag.id} ${tag.text}（${tag.status}）`).join('；')}`);
  }
  for (const member of existing.members) {
    if (member.tags.length === 0) continue;
    lines.push(`群友 ${member.userId} 的标签：${member.tags.map((tag) => `#${tag.id} ${tag.text}（${tag.status}）`).join('；')}`);
  }
  return lines.length > 0 ? lines.join('\n') : '（暂无）';
}

// 每行格式同回复上下文，额外带上 #消息ID 与发送者 QQ 号。
export function buildExtractMessages(
  records: readonly MessageStorageRecord[],
  existing: ExistingTagsInput,
  template: ExtractTagsPromptTemplate,
): OpenAI.ChatCompletionMessageParam[] {
  const contextText = records.slice(-80).map((record) => {
    const speaker = record.isSelf
      ? `你(QQ ${record.senderId})`
      : `${JSON.stringify(record.senderName)}(QQ ${record.senderId})`;
    return `[${formatTime(record.time)}] ${speaker}: ${record.plainText} #${record.messageId}`;
  }).join('\n');

  return [
    { role: 'system', content: template.system },
    {
      role: 'user',
      content: template.user
        .replaceAll('{{context}}', contextText)
        .replaceAll('{{existing}}', formatExistingTags(existing)),
    },
  ];
}

function arraysOf(value: unknown): ExtractSubjectItems | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const observe = record.observe ?? [];
  const added = record.new ?? [];
  const contradict = record.contradict ?? [];
  if (!Array.isArray(observe) || !Array.isArray(added) || !Array.isArray(contradict)) return undefined;
  return { observe, new: added, contradict };
}

// 结构级解析：group/members 形状不对视为整体解析失败；条目级校验在提取流程里逐条进行。
export function parseExtractResponse(text: string): ParsedExtractResponse | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const group = arraysOf(record.group);
  if (!group) return undefined;
  const membersField = record.members ?? [];
  if (!Array.isArray(membersField)) return undefined;

  const members: ExtractMemberItems[] = [];
  for (const entry of membersField) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
    const userId = (entry as Record<string, unknown>).userId;
    if (typeof userId !== 'number' || !Number.isSafeInteger(userId)) return undefined;
    const items = arraysOf(entry);
    if (!items) return undefined;
    members.push({ userId, ...items });
  }
  return { group, members };
}

export function asObserveItem(raw: unknown): ExtractObserveItem | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== 'number' || !Number.isSafeInteger(record.id)) return undefined;
  if (typeof record.messageId !== 'string' || record.messageId.length === 0) return undefined;
  return { id: record.id, messageId: record.messageId };
}

export function asNewItem(raw: unknown): ExtractNewItem | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record.text !== 'string') return undefined;
  if (typeof record.messageId !== 'string' || record.messageId.length === 0) return undefined;
  return { text: record.text, messageId: record.messageId };
}

export function asContradictItem(raw: unknown): ExtractContradictItem | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== 'number' || !Number.isSafeInteger(record.id)) return undefined;
  if (typeof record.text !== 'string') return undefined;
  if (typeof record.messageId !== 'string' || record.messageId.length === 0) return undefined;
  return { id: record.id, text: record.text, messageId: record.messageId };
}

export async function runExtract(
  records: readonly MessageStorageRecord[],
  existing: ExistingTagsInput,
  template: ExtractTagsPromptTemplate,
  callModel: ExtractSlotCall,
): Promise<ExtractResult> {
  const messages = buildExtractMessages(records, existing, template);
  let response: { text: string };
  try {
    response = await callModel('extract', messages);
  } catch {
    return { ok: false, reason: 'extract_error' };
  }

  const parsed = parseExtractResponse(response.text);
  if (!parsed) return { ok: false, reason: 'extract_parse_error' };
  return { ok: true, parsed };
}
