import type OpenAI from 'openai';
import type { StoredTag } from '../../store/affect-repo.ts';
import type { MessageStorageRecord } from '../../store/repository.ts';
import { isTagCategoryKey, isTagPolarity, normalizeTagSubject, type TagCategoryKey, type TagPolarity } from './tag-model.ts';
import type { TagSubjectRecord } from '../../store/tag-subject-repo.ts';
import type { ExtractTagsPromptTemplate } from '../prompt-templates.ts';

export interface ExtractObserveItem {
  id: number;
  messageId: string;
}

export interface ExtractNewItem {
  text: string;
  messageId: string;
  category: TagCategoryKey;
  subject: string | null;
  polarity: TagPolarity;
  origin: 'self_report' | 'inferred';
  sensitive: boolean;
}

export interface ExtractContradictItem extends ExtractNewItem {
  id: number;
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
  | { ok: false; reason: 'extract_parse_error' }
  | { ok: false; reason: 'extract_error'; error: unknown };

export type ExtractSlotCall = (
  slot: 'extract',
  messages: OpenAI.ChatCompletionMessageParam[],
) => Promise<{ text: string }>;

export interface ExistingTagsInput {
  group: StoredTag[];
  members: Array<{ userId: number; tags: StoredTag[] }>;
  subjects?: TagSubjectRecord[];
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function formatExistingTags(existing: ExistingTagsInput): string {
  const lines: string[] = [];
  const groupTags = existing.group.filter((tag) => !tag.locked);
  if (groupTags.length > 0) {
    lines.push(`群标签：${groupTags.map((tag) => `#${tag.id} ${tag.text}（${tag.status}）`).join('；')}`);
  }
  for (const member of existing.members) {
    const tags = member.tags.filter((tag) => !tag.locked);
    if (tags.length === 0) continue;
    lines.push(`群友 ${member.userId} 的标签：${tags.map((tag) => `#${tag.id} ${tag.text}（${tag.status}）`).join('；')}`);
  }
  const subjects = existing.subjects ?? [];
  lines.push(`可复用的 fandom tag_subjects（规范名；别名）：${subjects.length > 0
    ? subjects.map((subject) => `${subject.name}${subject.aliases.length > 0 ? `（${subject.aliases.join('、')}）` : ''}`).join('；')
    : '（暂无）'}`);
  return lines.length > 0 ? lines.join('\n') : '（暂无）';
}

export function isExternalLinkShareText(text: string): boolean {
  return /@url\s*:/iu.test(text);
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
    const text = isExternalLinkShareText(record.plainText)
      ? '分享了外链卡片（卡片文案不代表发言者观点）'
      : record.plainText;
    return `[${formatTime(record.time)}] ${speaker}: ${text} #${record.messageId}`;
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

function tagProfile(record: Record<string, unknown>): Omit<ExtractNewItem, 'text' | 'messageId'> | undefined {
  const category = record.category;
  const subject = record.subject;
  const polarity = record.polarity;
  const origin = record.origin;
  const sensitive = record.sensitive;
  if (!isTagCategoryKey(category)) return undefined;
  if (category === 'schedule') return undefined;
  if (subject !== null && typeof subject !== 'string') return undefined;
  if (typeof subject === 'string' && !normalizeTagSubject(subject)) return undefined;
  if (polarity !== null && !isTagPolarity(polarity)) return undefined;
  if (category !== 'fandom' && (subject !== null || polarity !== null)) return undefined;
  if (origin !== 'self_report' && origin !== 'inferred') return undefined;
  if (typeof sensitive !== 'boolean') return undefined;
  return {
    category,
    subject,
    polarity,
    origin,
    sensitive,
  };
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
  const profile = tagProfile(record);
  if (!profile) return undefined;
  return { text: record.text, messageId: record.messageId, ...profile };
}

export function asContradictItem(raw: unknown): ExtractContradictItem | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== 'number' || !Number.isSafeInteger(record.id)) return undefined;
  if (typeof record.text !== 'string') return undefined;
  if (typeof record.messageId !== 'string' || record.messageId.length === 0) return undefined;
  const profile = tagProfile(record);
  if (!profile) return undefined;
  return { id: record.id, text: record.text, messageId: record.messageId, ...profile };
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
  } catch (error) {
    return { ok: false, reason: 'extract_error', error };
  }

  const parsed = parseExtractResponse(response.text);
  if (!parsed) return { ok: false, reason: 'extract_parse_error' };
  return { ok: true, parsed };
}
