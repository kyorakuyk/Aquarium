export const TAG_CATEGORY_KEYS = [
  'identity',
  'personality',
  'fandom',
  'speech',
  'social',
  'recent',
  'dislike',
  'schedule',
  'atmosphere',
] as const;

export type TagCategoryKey = typeof TAG_CATEGORY_KEYS[number];
export type TagCategory = TagCategoryKey | 'misc';
export type TagOrigin = 'self_report' | 'inferred' | 'stats' | 'manual';
export type TagPolarity = 'like' | 'dislike' | null;

const DAY_MS = 24 * 60 * 60 * 1000;

export const TAG_CATEGORY_HALF_LIFE_MS: Readonly<Record<TagCategoryKey, number | null>> = {
  identity: 180 * DAY_MS,
  personality: 30 * DAY_MS,
  fandom: 30 * DAY_MS,
  speech: 30 * DAY_MS,
  social: 30 * DAY_MS,
  recent: 3 * DAY_MS,
  dislike: 60 * DAY_MS,
  schedule: null,
  atmosphere: 14 * DAY_MS,
};

export function isTagCategoryKey(value: unknown): value is TagCategoryKey {
  return typeof value === 'string' && (TAG_CATEGORY_KEYS as readonly string[]).includes(value);
}

export function isTagCategory(value: unknown): value is TagCategory {
  return value === 'misc' || isTagCategoryKey(value);
}

export function isTagOrigin(value: unknown): value is TagOrigin {
  return value === 'self_report' || value === 'inferred' || value === 'stats' || value === 'manual';
}

export function isTagPolarity(value: unknown): value is Exclude<TagPolarity, null> {
  return value === 'like' || value === 'dislike';
}

export function normalizeTagSubject(value: string): string {
  return value.replace(/[\s\p{P}]/gu, '').toLowerCase();
}

export interface TagSubjectAliasSource {
  name: string;
  aliases: readonly string[];
}

export function canonicalizeTagSubject(
  value: string,
  subjects: readonly TagSubjectAliasSource[],
): string {
  const normalized = normalizeTagSubject(value);
  if (!normalized) throw new RangeError('标签 subject 不能为空');
  const canonical = subjects.find((subject) => (
    normalizeTagSubject(subject.name) === normalized
    || subject.aliases.some((alias) => normalizeTagSubject(alias) === normalized)
  ));
  return canonical?.name ?? value.trim();
}
