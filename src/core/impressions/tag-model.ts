export const TAG_CATEGORY_KEYS = [
  'positioning',
  'topic',
  'atmosphere',
  'meme',
  'norms',
  'identity',
  'personality',
  'fandom',
  'speech',
  'catchphrase',
  'social',
  'recent',
  'dislike',
  'schedule',
] as const;

export type TagCategoryKey = typeof TAG_CATEGORY_KEYS[number];
export type TagCategory = TagCategoryKey | 'misc';
export type TagKind = 'fact' | 'view';
export type TagOrigin = 'self_report' | 'inferred' | 'stats' | 'manual';
export type TagPolarity = 'like' | 'dislike' | null;

const VIEW_TAG_CATEGORIES: ReadonlySet<TagCategory> = new Set([
  'atmosphere', 'personality', 'speech', 'social', 'dislike', 'misc',
]);

const DAY_MS = 24 * 60 * 60 * 1000;

export const TAG_CATEGORY_HALF_LIFE_MS: Readonly<Record<TagCategoryKey, number | null>> = {
  positioning: 180 * DAY_MS,
  topic: 30 * DAY_MS,
  atmosphere: 14 * DAY_MS,
  meme: 60 * DAY_MS,
  norms: 180 * DAY_MS,
  identity: 180 * DAY_MS,
  personality: 30 * DAY_MS,
  fandom: 30 * DAY_MS,
  speech: 30 * DAY_MS,
  catchphrase: 60 * DAY_MS,
  social: 30 * DAY_MS,
  recent: 3 * DAY_MS,
  dislike: 60 * DAY_MS,
  schedule: null,
};

export type TagScope = 'group' | 'member';

const GROUP_TAG_CATEGORIES: ReadonlySet<TagCategory> = new Set([
  'positioning', 'topic', 'atmosphere', 'meme', 'norms', 'recent', 'schedule', 'misc',
]);
const MEMBER_TAG_CATEGORIES: ReadonlySet<TagCategory> = new Set([
  'identity', 'personality', 'fandom', 'speech', 'catchphrase', 'social', 'recent', 'dislike', 'schedule', 'misc',
]);

export function isTagCategoryForScope(category: TagCategory, scope: TagScope): boolean {
  return (scope === 'group' ? GROUP_TAG_CATEGORIES : MEMBER_TAG_CATEGORIES).has(category);
}

export type TagDropReason = 'invalid_text' | 'recent_habit' | 'schedule_by_stats' | 'quote_missing' | 'vetoed';

export type TagTextPreparation =
  | { ok: true; text: string }
  | { ok: false; reason: TagDropReason };

const SCHEDULE_TEXT_PATTERN = /(?:深夜|熬夜|夜猫|凌晨|早起|作息|通宵)/u;
const RECENT_HABIT_PATTERN = /^(?:经常|常|总是|一直)/u;
const LEADING_TAG_VERB_PATTERN = /^(?:经常|喜欢|总是|老是|常|爱)\s*/u;

export function prepareTagText(
  category: TagCategoryKey,
  rawText: string,
  evidenceTexts: readonly string[],
): TagTextPreparation {
  const original = rawText.trim();
  if (!original) return { ok: false, reason: 'invalid_text' };
  if (SCHEDULE_TEXT_PATTERN.test(original)) return { ok: false, reason: 'schedule_by_stats' };
  if (category === 'recent' && RECENT_HABIT_PATTERN.test(original)) {
    return { ok: false, reason: 'recent_habit' };
  }

  let text = original;
  while (LEADING_TAG_VERB_PATTERN.test(text)) {
    text = text.replace(LEADING_TAG_VERB_PATTERN, '').trim();
  }
  if (!text || SCHEDULE_TEXT_PATTERN.test(text)) {
    return { ok: false, reason: text ? 'schedule_by_stats' : 'invalid_text' };
  }

  const length = Array.from(text).length;
  const maximum = category === 'meme' || category === 'catchphrase' ? 12 : 8;
  if (length < 2 || length > maximum) return { ok: false, reason: 'invalid_text' };
  if ((category === 'meme' || category === 'catchphrase')
    && !evidenceTexts.some((evidence) => evidence.includes(text))) {
    return { ok: false, reason: 'quote_missing' };
  }
  return { ok: true, text };
}

export function isTagCategoryKey(value: unknown): value is TagCategoryKey {
  return typeof value === 'string' && (TAG_CATEGORY_KEYS as readonly string[]).includes(value);
}

export function isTagCategory(value: unknown): value is TagCategory {
  return value === 'misc' || isTagCategoryKey(value);
}

export function tagKindFor(category: TagCategory, polarity: TagPolarity): TagKind {
  return polarity !== null || VIEW_TAG_CATEGORIES.has(category) ? 'view' : 'fact';
}

export function isTagKind(value: unknown): value is TagKind {
  return value === 'fact' || value === 'view';
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

export function normalizeTagSubjectPath(value: string): string | undefined {
  const levels = value.split('/').map((level) => level.trim());
  if (levels.length > 2 || levels.some((level) => !normalizeTagSubject(level))) return undefined;
  return levels.map(normalizeTagSubject).join('/');
}

export interface TagSubjectAliasSource {
  name: string;
  aliases: readonly string[];
}

export function canonicalizeTagSubject(
  value: string,
  subjects: readonly TagSubjectAliasSource[],
): string {
  const levels = value.split('/').map((level) => level.trim());
  if (levels.length > 2 || levels.some((level) => !normalizeTagSubject(level))) {
    throw new RangeError('标签 subject 路径无效');
  }
  return levels.map((level) => {
    const normalized = normalizeTagSubject(level);
    const canonical = subjects.find((subject) => (
      normalizeTagSubject(subject.name) === normalized
      || subject.aliases.some((alias) => normalizeTagSubject(alias) === normalized)
    ));
    return canonical?.name ?? level;
  }).join('/');
}
