import type { StoredTag, TagEvidence, TagStatus } from '../../store/affect-repo.ts';
import { TAG_CATEGORY_HALF_LIFE_MS } from '../../store/tag-profile.ts';

export const EVIDENCE_MAX = 5;

// 淡忘半衰期：群友 30 天、群 14 天；samples ≥ 4 时乘 3；manual 恒为 1。
export const MEMBER_TAG_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;
export const GROUP_TAG_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;

export const ACTIVATION_MIN = 0.25;

export const GROUP_TAGS_LIMIT = { max: 6, maxChars: 120 } as const;
export const MEMBER_TAGS_LIMIT = { max: 5, maxChars: 80 } as const;

export interface TagSelectionLimit {
  max: number;
  maxChars: number;
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
  if (existing.evidence.some((item) => item.messageId === input.messageId)) {
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

// 注入选择：confirmed 且激活度 ≥ 0.25；manual 优先 → samples 降序 → last_seen 降序；受数量与总长上限。
export function selectInjectableTags(
  tags: readonly StoredTag[],
  now: number,
  limit: TagSelectionLimit,
): { tags: StoredTag[]; dropped: number } {
  const eligible = tags
    .filter((tag) => tag.status === 'confirmed' && tagActivation(tag, now) >= ACTIVATION_MIN)
    .sort((left, right) => {
      if (left.source !== right.source) return left.source === 'manual' ? -1 : 1;
      if (left.samples !== right.samples) return right.samples - left.samples;
      return right.lastSeen - left.lastSeen;
    });

  const picked: StoredTag[] = [];
  let chars = 0;
  let dropped = 0;
  for (const tag of eligible) {
    if (picked.length >= limit.max) {
      dropped += 1;
      continue;
    }
    const length = Array.from(tag.text).length + (picked.length > 0 ? 1 : 0);
    if (chars + length > limit.maxChars) {
      dropped += 1;
      continue;
    }
    chars += length;
    picked.push(tag);
  }
  return { tags: picked, dropped };
}
