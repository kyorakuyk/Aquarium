import type { StoredTag } from '../../store/affect-repo.ts';
import type { TagCategory } from './tag-model.ts';
import { ACTIVATION_MIN, MEMBER_TAGS_LIMIT, tagActivation } from './tags.ts';
import { redactSensitiveText } from './sensitive-text.ts';

type MemberGroup = 'dislike' | 'personality' | 'fandom' | 'identity' | 'recent' | 'schedule' | 'communication';

const MEMBER_GROUP_ORDER: readonly MemberGroup[] = [
  'dislike', 'personality', 'fandom', 'identity', 'recent', 'schedule', 'communication',
];

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
  const leftGroup = memberGroup(left.category);
  const rightGroup = memberGroup(right.category);
  const groupOrder = MEMBER_GROUP_ORDER.indexOf(leftGroup ?? 'communication')
    - MEMBER_GROUP_ORDER.indexOf(rightGroup ?? 'communication');
  if (groupOrder !== 0) return groupOrder;
  if (leftGroup === 'communication' && left.category !== right.category) {
    const communicationOrder = { speech: 0, catchphrase: 1, social: 2 } as const;
    return communicationOrder[left.category as keyof typeof communicationOrder]
      - communicationOrder[right.category as keyof typeof communicationOrder];
  }
  if (left.source !== right.source) return left.source === 'manual' ? -1 : 1;
  if (left.samples !== right.samples) return right.samples - left.samples;
  if (left.lastSeen !== right.lastSeen) return right.lastSeen - left.lastSeen;
  return left.id - right.id;
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
  const selfReports = uniqueTexts(tags
    .filter((tag) => tag.origin === 'self_report')
    .sort((left, right) => left.firstSeen - right.firstSeen || left.id - right.id));
  const inferred = uniqueTexts(tags.filter((tag) => tag.origin === 'inferred'));
  const parts = [
    ...(selfReports.length === 1 ? [`自称 ${selfReports[0]}`] : []),
    ...(selfReports.length > 1 ? [`自称在 ${selfReports.join('/')} 间摇摆`] : []),
    ...inferred.map((text) => `（推测，仅供参考，别据此下结论）${text}`),
  ];
  return parts.length > 0 ? parts.join('、') : undefined;
}

function textLength(value: string): number {
  return Array.from(value).length;
}

export function formatMemberTags(tags: readonly StoredTag[]): string {
  const ordered = [...tags].filter((tag) => memberGroup(tag.category)).sort(compareTags);
  const groups = [
    labeledGroup('雷点', ordered.filter((tag) => tag.category === 'dislike')),
    labeledGroup('性格', ordered.filter((tag) => tag.category === 'personality')),
    (() => {
      const fandom = ordered.filter((tag) => tag.category === 'fandom');
      return fandom.length > 0 ? `成分：${fandomText(fandom)}` : undefined;
    })(),
    identityText(ordered.filter((tag) => tag.category === 'identity')),
    labeledGroup('近况', ordered.filter((tag) => tag.category === 'recent')),
    labeledGroup('作息', ordered.filter((tag) => tag.category === 'schedule')),
    (() => {
      const communication = [
        labeledGroup('说话风格', ordered.filter((tag) => tag.category === 'speech')),
        labeledGroup('口头禅', ordered.filter((tag) => tag.category === 'catchphrase'), ({ text }) => quotedTagText(text)),
        labeledGroup('社交方式', ordered.filter((tag) => tag.category === 'social')),
      ].filter((group): group is string => group !== undefined);
      return communication.length > 0 ? communication.join('、') : undefined;
    })(),
  ];
  return groups.filter((group): group is string => group !== undefined).join('；');
}

export function buildMemberTagPrompt(
  tags: readonly StoredTag[],
  now: number,
  profile?: MemberPromptProfile,
): { text: string; dropped: number; profileText: string } {
  const eligible = tags
    .filter((tag) => !tag.locked
      && memberGroup(tag.category) !== undefined
      && tag.category !== 'misc'
      && tag.category !== 'atmosphere'
      && tag.status === 'confirmed'
      && tagActivation(tag, now) >= ACTIVATION_MIN
      && (tag.category !== 'identity' || tag.origin === 'self_report' || tag.origin === 'inferred'))
    .sort(compareTags);
  const selected: StoredTag[] = [];
  let chars = 0;
  let dropped = 0;
  for (const tag of eligible) {
    if (selected.length >= MEMBER_TAGS_LIMIT.max) {
      dropped += 1;
      continue;
    }
    const length = textLength(tag.text) + (selected.length > 0 ? 1 : 0);
    if (chars + length > MEMBER_TAGS_LIMIT.maxChars) {
      dropped += 1;
      continue;
    }
    chars += length;
    selected.push(tag);
  }

  let retained = selected;
  let text = formatMemberTags(retained);
  while (textLength(text) > MEMBER_TAGS_LIMIT.maxChars && retained.length > 0) {
    const groups = [...new Set(retained.map((tag) => memberGroup(tag.category)))]
      .filter((group): group is MemberGroup => group !== undefined)
      .sort((left, right) => MEMBER_GROUP_ORDER.indexOf(left) - MEMBER_GROUP_ORDER.indexOf(right));
    const lastGroup = groups.at(-1);
    if (!lastGroup) break;
    const removable = retained.filter((tag) => memberGroup(tag.category) === lastGroup);
    const removeIds = new Set((groups.length === 1 ? removable.slice(-1) : removable).map((tag) => tag.id));
    retained = retained.filter((tag) => !removeIds.has(tag.id));
    dropped += removeIds.size;
    text = formatMemberTags(retained);
  }
  return { text, dropped, profileText: formatMemberProfileContext(profile) };
}
