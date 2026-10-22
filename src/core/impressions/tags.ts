import type { StoredTag, TagEvidence, TagStatus } from '../../store/affect-repo.ts';
import { TAG_CATEGORY_HALF_LIFE_MS } from './tag-model.ts';

export const EVIDENCE_MAX = 5;

// misc 半衰期 30 天；samples ≥ 4 时乘 3；manual 恒为 1。
export const MEMBER_TAG_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;
export const GROUP_TAG_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

export const ACTIVATION_MIN = 0.25;
const TAG_PROMPT_THRESHOLD_EPSILON = Number.EPSILON;

export const GROUP_TAGS_LIMIT = { max: 6, maxChars: 120 } as const;
export const MEMBER_TAGS_LIMIT = { max: 5, maxChars: 160 } as const;

export interface TagSelectionLimit {
  max: number;
  maxChars: number;
}

export interface TagPromptStateUpdate {
  id: number;
  inPrompt: boolean;
}

export interface TagSelectionOptions {
  isEligible?: (tag: StoredTag) => boolean;
  includeMisc?: boolean;
  renderText?: (tags: readonly StoredTag[]) => string;
}

export interface TagCandidateInput {
  text: string;
  norm?: string;
  messageId: string;
  time: number;
  quote: string;
}

export interface TagContradictionInput {
  id: number;
  text: string;
  messageId: string;
  time: number;
  quote: string;
}

export type TagObservationOutcome =
  | { action: 'insert'; text: string; norm: string; evidence: TagEvidence[] }
  | { action: 'observe'; id: number; samples: number; status: TagStatus; lastSeen: number; evidence: TagEvidence[] }
  | { action: 'ignore'; reason: 'no_revival' | 'duplicate' };

export type TagContradictionOutcome =
  | { action: 'insert'; text: string; norm: string; evidence: TagEvidence[]; supersedes: number }
  | { action: 'ignore'; reason: 'not_found' | 'manual_target' };

// 规范化：去空白与标点、转小写，用于判重。
export function normalizeTagText(text: string): string {
  return text.replace(/[\s\p{P}]/gu, '').toLowerCase();
}

export function tagHalfLifeMs(tag: Pick<StoredTag, 'category' | 'userId' | 'samples'>): number | null {
  const base = tag.category === 'misc'
    ? tag.userId === null ? GROUP_TAG_HALF_LIFE_MS : MEMBER_TAG_HALF_LIFE_MS
    : TAG_CATEGORY_HALF_LIFE_MS[tag.category];
  if (base === null) return null;
  return tag.samples >= 4 ? base * 3 : base;
}

// 激活度 = 2^(−(now − last_seen) / 半衰期)；manual 标签恒为 1。
export function tagActivation(
  tag: Pick<StoredTag, 'source' | 'category' | 'userId' | 'samples' | 'lastSeen'>,
  now: number,
): number {
  if (tag.source === 'manual') return 1;
  const halfLife = tagHalfLifeMs(tag);
  if (halfLife === null) return 1;
  return 2 ** (-(now - tag.lastSeen) / halfLife);
}

function evidenceOf(input: TagCandidateInput): TagEvidence {
  return { messageId: input.messageId, time: input.time, quote: input.quote };
}

// 观察：证据 messageId 不在已有 evidence 里才算独立观察；rejected / superseded 不复活。
export function applyTagObservation(
  tags: readonly StoredTag[],
  input: TagCandidateInput,
): TagObservationOutcome {
  const norm = input.norm ?? normalizeTagText(input.text);
  const existing = tags.find((tag) => tag.norm === norm);
  if (!existing) {
    return { action: 'insert', text: input.text, norm, evidence: [evidenceOf(input)] };
  }
  if (existing.status === 'rejected' || existing.status === 'superseded') {
    return { action: 'ignore', reason: 'no_revival' };
  }
  if (existing.evidence.some((item) => item.kind !== 'signature' && item.messageId === input.messageId)) {
    return { action: 'ignore', reason: 'duplicate' };
  }
  const samples = existing.samples + 1;
  const inferredIdentity = existing.category === 'identity' && existing.origin === 'inferred';
  const status: TagStatus = existing.status === 'candidate' && samples >= 2 && !inferredIdentity
    ? 'confirmed'
    : existing.status;
  return {
    action: 'observe',
    id: existing.id,
    samples,
    status,
    lastSeen: input.time,
    evidence: [...existing.evidence, evidenceOf(input)].slice(-EVIDENCE_MAX),
  };
}

// 推翻：只接受同一主语下的 auto 标签；manual 目标直接丢弃。
export function applyTagContradiction(
  tags: readonly StoredTag[],
  input: TagContradictionInput,
): TagContradictionOutcome {
  const target = tags.find((tag) => tag.id === input.id);
  if (!target) return { action: 'ignore', reason: 'not_found' };
  if (target.source === 'manual') return { action: 'ignore', reason: 'manual_target' };
  return {
    action: 'insert',
    text: input.text,
    norm: normalizeTagText(input.text),
    evidence: [evidenceOf(input)],
    supersedes: target.id,
  };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareTagOrder(left: StoredTag, right: StoredTag): number {
  return compareText(left.category, right.category)
    || compareText(left.norm, right.norm)
    || left.id - right.id;
}

function selectionText(tags: readonly StoredTag[], options: TagSelectionOptions): string {
  return options.renderText?.(tags) ?? tags.map(({ text }) => text).join('、');
}

function textLength(value: string): number {
  return Array.from(value).length;
}

// 入选状态使用迟滞；容量裁剪只移除置信度最低的条目，最终文本按 category/norm 固定排序。
export function selectInjectableTags(
  tags: readonly StoredTag[],
  now: number,
  limit: TagSelectionLimit,
  options: TagSelectionOptions = {},
): { tags: StoredTag[]; dropped: number; stateUpdates: TagPromptStateUpdate[] } {
  const candidates: Array<{ tag: StoredTag; confidence: number; manual: boolean }> = [];
  for (const tag of tags) {
    const eligible = !tag.locked && (options.includeMisc === true || tag.category !== 'misc') && tag.status === 'confirmed'
      && (options.isEligible?.(tag) ?? true);
    const manual = tag.origin === 'manual' || tag.source === 'manual';
    const activation = tagActivation(tag, now);
    const inPrompt = eligible && (manual || (tag.inPrompt
      ? activation - 0.35 > TAG_PROMPT_THRESHOLD_EPSILON
      : activation >= 0.5 - TAG_PROMPT_THRESHOLD_EPSILON));
    if (inPrompt) candidates.push({ tag, confidence: manual ? 1 : activation, manual });
  }

  const retained = new Map(candidates.map(({ tag }) => [tag.id, tag]));
  const removalOrder = [...candidates].sort((left, right) => left.confidence - right.confidence
    || Number(left.manual) - Number(right.manual)
    || compareTagOrder(left.tag, right.tag));
  let dropped = 0;
  const sortedTags = () => [...retained.values()].sort(compareTagOrder);
  while (retained.size > limit.max || textLength(selectionText(sortedTags(), options)) > limit.maxChars) {
    const lowest = removalOrder.find(({ tag }) => retained.has(tag.id));
    if (!lowest) break;
    retained.delete(lowest.tag.id);
    dropped += 1;
  }
  const candidateIds = new Set(candidates.map(({ tag }) => tag.id));
  const selectedIds = new Set(retained.keys());
  const stateUpdates = tags.flatMap((tag) => {
    const inPrompt = candidateIds.has(tag.id) && selectedIds.has(tag.id);
    return tag.inPrompt !== inPrompt ? [{ id: tag.id, inPrompt }] : [];
  }).sort((left, right) => left.id - right.id);
  return {
    tags: sortedTags(),
    dropped,
    stateUpdates,
  };
}
