import type { StoredTag } from '../../store/affect-repo.ts';
import { TAG_CATEGORY_KEYS, type TagCategory } from './tag-model.ts';
import { MEMBER_TAGS_LIMIT, selectInjectableTags, type TagPromptStateUpdate } from './tags.ts';
import { redactSensitiveText } from './sensitive-text.ts';

type MemberGroup = 'dislike' | 'personality' | 'fandom' | 'identity' | 'recent' | 'schedule' | 'communication';

export interface MemberPromptProfile {
  card?: string;
  role?: 'owner' | 'admin' | 'member';
  title?: string;
  relationships?: readonly string[];
}

function promptProfileValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const text = Array.from(redactSensitiveText(value.trim())).slice(0, 80).join('');
  return text.length > 0 ? JSON.stringify(text) : undefined;
}

export function formatMemberProfileContext(profile?: MemberPromptProfile): string {
  if (!profile) return '';
  const fields: string[] = [];
  const card = promptProfileValue(profile.card);
  const title = promptProfileValue(profile.title);
  if (card) fields.push(`群名片：${card}`);
  if (profile.role === 'owner') fields.push('群主');
  else if (profile.role === 'admin') fields.push('管理员');
  if (title) fields.push(`头衔：${title}`);
  fields.push(...(profile.relationships ?? []).filter((relationship) => relationship.length > 0));
  return fields.length > 0 ? `（${fields.join('，')}）` : '';
}

function memberGroup(category: TagCategory): MemberGroup | undefined {
  switch (category) {
    case 'dislike':
    case 'personality':
    case 'fandom':
    case 'identity':
    case 'recent':
    case 'schedule':
      return category;
    case 'catchphrase':
    case 'speech':
    case 'social':
      return 'communication';
    default:
      return undefined;
  }
}

function compareTags(left: StoredTag, right: StoredTag): number {
  const leftOrder = TAG_CATEGORY_KEYS.indexOf(left.category as typeof TAG_CATEGORY_KEYS[number]);
  const rightOrder = TAG_CATEGORY_KEYS.indexOf(right.category as typeof TAG_CATEGORY_KEYS[number]);
  return leftOrder - rightOrder
    || (left.norm < right.norm ? -1 : left.norm > right.norm ? 1 : 0)
    || left.id - right.id;
}

function uniqueTexts(tags: readonly StoredTag[]): string[] {
  const seen = new Set<string>();
  return tags.flatMap(({ text }) => {
    if (seen.has(text)) return [];
    seen.add(text);
    return [text];
  });
}

function quotedTagText(text: string): string {
  return text.startsWith('「') && text.endsWith('」') ? text : `「${text}」`;
}

function labeledGroup(
  label: string,
  tags: readonly StoredTag[],
  formatText: (tag: StoredTag) => string = (tag) => tag.text,
): string | undefined {
  return tags.length === 0 ? undefined : `${label}：${tags.map(formatText).join('、')}`;
}

function fandomText(tags: readonly StoredTag[]): string {
  const groups: Array<{ subject: string; tags: StoredTag[] }> = [];
  for (const tag of tags) {
    const subject = tag.subject?.trim() ?? '';
    let group = groups.find((item) => item.subject === subject);
    if (!group) {
      group = { subject, tags: [] };
      groups.push(group);
    }
    group.tags.push(tag);
  }
  return groups.map(({ subject, tags: subjectTags }) => {
    const likes = uniqueTexts(subjectTags.filter((tag) => tag.polarity === 'like'));
    const neutral = uniqueTexts(subjectTags.filter((tag) => tag.polarity === null));
    const dislikes = uniqueTexts(subjectTags.filter((tag) => tag.polarity === 'dislike'));
    const parts = [
      ...(likes.length > 0 ? [likes.join('/')] : []),
      ...(neutral.length > 0 ? [neutral.join('/')] : []),
      ...(dislikes.length > 0 ? [`不喜欢${dislikes.join('/')}`] : []),
    ];
    const content = parts.join('，');
    return subject ? `${subject.replaceAll('/', ' › ')}（${content}）` : content;
  }).filter(Boolean).join('、');
}

function identityText(tags: readonly StoredTag[]): string | undefined {
  const selfReports = uniqueTexts(tags.filter((tag) => tag.origin === 'self_report'));
  const inferred = uniqueTexts(tags.filter((tag) => tag.origin === 'inferred'));
  const parts = [
    ...(selfReports.length === 1 ? [`自称 ${selfReports[0]}`] : []),
    ...(selfReports.length > 1 ? [`自称在 ${selfReports.join('/')} 间摇摆`] : []),
    ...inferred.map((text) => `（推测，仅供参考，别据此下结论）${text}`),
  ];
  return parts.length > 0 ? parts.join('、') : undefined;
}

export function formatMemberTags(tags: readonly StoredTag[]): string {
  const ordered = [...tags].filter((tag) => memberGroup(tag.category)).sort(compareTags);
  const groups = [
    identityText(ordered.filter((tag) => tag.category === 'identity')),
    labeledGroup('性格', ordered.filter((tag) => tag.category === 'personality')),
    (() => {
      const fandom = ordered.filter((tag) => tag.category === 'fandom');
      return fandom.length > 0 ? `成分：${fandomText(fandom)}` : undefined;
    })(),
    (() => {
      const communication = [
        labeledGroup('说话风格', ordered.filter((tag) => tag.category === 'speech')),
        (() => {
          const catchphrases = ordered.filter((tag) => tag.category === 'catchphrase');
          return catchphrases.length > 0
            ? `口头禅${catchphrases.map(({ text }) => quotedTagText(text)).join('')}`
            : undefined;
        })(),
        labeledGroup('社交方式', ordered.filter((tag) => tag.category === 'social')),
      ].filter((group): group is string => group !== undefined);
      return communication.length > 0 ? communication.join('、') : undefined;
    })(),
    labeledGroup('近况', ordered.filter((tag) => tag.category === 'recent')),
    labeledGroup('雷点', ordered.filter((tag) => tag.category === 'dislike')),
    labeledGroup('作息', ordered.filter((tag) => tag.category === 'schedule')),
  ];
  return groups.filter((group): group is string => group !== undefined).join('；');
}

export function buildMemberTagPrompt(
  tags: readonly StoredTag[],
  now: number,
  profile?: MemberPromptProfile,
): { text: string; dropped: number; profileText: string; stateUpdates: TagPromptStateUpdate[] } {
  const selection = selectInjectableTags(tags, now, MEMBER_TAGS_LIMIT, {
    isEligible: (tag) => memberGroup(tag.category) !== undefined
      && (tag.category !== 'identity' || tag.origin === 'self_report' || tag.origin === 'inferred'),
    renderText: formatMemberTags,
  });
  return {
    text: formatMemberTags(selection.tags),
    dropped: selection.dropped,
    profileText: formatMemberProfileContext(profile),
    stateUpdates: selection.stateUpdates,
  };
}
