import assert from 'node:assert/strict';
import test from 'node:test';
import * as impressionsModel from '../panel/src/impressions-model.ts';
import {
  activityCalendarCells,
  activityLevel,
  memberIdentityInjectionLabel,
  memberIdentityMbti,
  memberPreviewTags,
  recentTagFadeLabel,
} from '../panel/src/impressions-model.ts';
import type { ViewImpression } from '../panel/src/api.ts';

const day = 24 * 60 * 60 * 1_000;

function identityTag(text: string, samples: number, origin = 'self_report') {
  return {
    id: samples + text.length,
    text,
    category: 'identity',
    subject: null,
    polarity: null,
    origin,
    locked: false,
    status: 'confirmed',
    source: 'auto',
    samples,
    activation: 1,
    evidence: [],
    firstSeen: 0,
    lastSeen: 0,
    fadeAt: null,
  };
}

test('activity heat levels use five bins relative to that person’s maximum', () => {
  assert.deepEqual([0, 1, 2, 4, 6, 8, 10].map((value) => activityLevel(value, 10)), [0, 0, 1, 2, 3, 4, 4]);
  assert.equal(activityLevel(8, 0), 0);
});

test('calendar cells preserve local weekday and week columns', () => {
  const cells = activityCalendarCells([
    { date: '2026-06-08', count: 1 },
    { date: '2026-06-09', count: 2 },
    { date: '2026-06-14', count: 3 },
    { date: '2026-06-15', count: 4 },
  ]);

  assert.equal(cells.length, 4);
  assert.deepEqual(cells.map(({ date, week, weekday }) => [date, week, weekday]), [
    ['2026-06-08', 0, (new Date(2026, 5, 8).getDay() + 6) % 7],
    ['2026-06-09', 0, (new Date(2026, 5, 9).getDay() + 6) % 7],
    ['2026-06-14', 0, (new Date(2026, 5, 14).getDay() + 6) % 7],
    ['2026-06-15', 1, (new Date(2026, 5, 15).getDay() + 6) % 7],
  ]);
});

test('identity summary marks disagreement with ? and exposes per-letter counts', () => {
  const result = memberIdentityMbti([
    identityTag('INTJ', 3),
    identityTag('INFJ', 2),
    identityTag('ENTP', 8, 'inferred'),
  ]);

  assert.equal(result?.text, 'IN?J');
  assert.match(result?.title ?? '', /T 3 次/);
  assert.match(result?.title ?? '', /F 2 次/);
});

test('inferred identity label distinguishes unconfirmed from manual confirmation', () => {
  assert.equal(memberIdentityInjectionLabel({ category: 'identity', origin: 'inferred', status: 'candidate' }), '推测 · 未注入');
  assert.equal(memberIdentityInjectionLabel({ category: 'identity', origin: 'inferred', status: 'confirmed' }), '推测 · 已手动确认');
  assert.equal(memberIdentityInjectionLabel({ category: 'identity', origin: 'self_report', status: 'confirmed' }), undefined);
});

test('member preview hides view tags and excludes locked, candidate, inferred identity and misc tags', () => {
  const tags = [
    { id: 1, text: '幽默', category: 'personality', kind: 'view', origin: 'inferred', locked: false, status: 'confirmed', activation: 1, samples: 3, lastSeen: 3 },
    { id: 2, text: '不喜欢外号', category: 'dislike', kind: 'view', origin: 'inferred', locked: false, status: 'confirmed', activation: 1, samples: 2, lastSeen: 2 },
    { id: 3, text: '锁定', category: 'identity', kind: 'fact', origin: 'inferred', locked: true, status: 'confirmed', activation: 1, samples: 4, lastSeen: 5 },
    { id: 4, text: '观察中', category: 'recent', kind: 'fact', origin: 'inferred', locked: false, status: 'candidate', activation: 1, samples: 1, lastSeen: 5 },
    { id: 5, text: 'INTP', category: 'identity', kind: 'fact', origin: 'inferred', locked: false, status: 'confirmed', activation: 1, samples: 4, lastSeen: 5 },
    { id: 6, text: '旧标签', category: 'misc', kind: 'view', origin: 'manual', locked: false, status: 'confirmed', activation: 1, samples: 2, lastSeen: 5 },
    { id: 7, text: 'CS2', category: 'fandom', kind: 'fact', origin: 'self_report', locked: false, status: 'confirmed', activation: 1, samples: 1, lastSeen: 5 },
    { id: 8, text: '准备搬家', category: 'recent', kind: 'fact', origin: 'inferred', locked: false, status: 'confirmed', activation: 0.8, samples: 2, lastSeen: 4 },
  ];

  assert.deepEqual(memberPreviewTags(tags).map(({ text }) => text), ['CS2', '准备搬家']);
});

test('knowledge tag columns filter to facts and format confidence and source labels', () => {
  const knowledgeTags = Reflect.get(impressionsModel, 'knowledgeTags') as
    ((tags: readonly { kind: 'fact' | 'view'; text: string }[]) => Array<{ kind: 'fact' | 'view'; text: string }>) | undefined;
  const formatTagConfidence = Reflect.get(impressionsModel, 'formatTagConfidence') as ((value: number) => string) | undefined;
  const tagOriginLabel = Reflect.get(impressionsModel, 'tagOriginLabel') as ((origin: string) => string) | undefined;

  assert.equal(typeof knowledgeTags, 'function');
  assert.equal(typeof formatTagConfidence, 'function');
  assert.equal(typeof tagOriginLabel, 'function');
  if (!knowledgeTags || !formatTagConfidence || !tagOriginLabel) return;
  assert.deepEqual(knowledgeTags([{ kind: 'view', text: '主观看法' }, { kind: 'fact', text: '客观事实' }]), [
    { kind: 'fact', text: '客观事实' },
  ]);
  assert.equal(formatTagConfidence(0.5), '0.50');
  assert.deepEqual(['self_report', 'stats', 'inferred', 'manual'].map(tagOriginLabel), [
    '自述', '统计', '推断', '手动',
  ]);
});

test('member list shows a message count instead of empty tag copy and repeated neutral affinity', () => {
  const memberRowPresentation = Reflect.get(impressionsModel, 'memberRowPresentation') as (
    highlights: readonly string[],
    messageCount: number,
    affinityLevel: string,
  ) => { subtitle: string; showAffinity: boolean };

  assert.equal(typeof memberRowPresentation, 'function');
  if (typeof memberRowPresentation !== 'function') return;
  assert.deepEqual(memberRowPresentation([], 7, 'neutral'), { subtitle: '7 条发言', showAffinity: false });
  assert.deepEqual(memberRowPresentation([], 0, 'neutral'), { subtitle: '0 条发言', showAffinity: false });
  assert.deepEqual(memberRowPresentation([], 7, 'warm'), { subtitle: '7 条发言', showAffinity: true });
  assert.deepEqual(memberRowPresentation(['游戏 › FPS', '短句连发'], 7, 'neutral'), {
    subtitle: '游戏 › FPS · 短句连发',
    showAffinity: true,
  });
});

test('QQ sex and age formatting treats zero age as private without repeating unknown values', () => {
  const memberSexAgeLabel = Reflect.get(impressionsModel, 'memberSexAgeLabel') as (
    sex: string | undefined,
    age: number | undefined,
  ) => string;

  assert.equal(typeof memberSexAgeLabel, 'function');
  if (typeof memberSexAgeLabel !== 'function') return;
  assert.equal(memberSexAgeLabel('male', 18), '男 · 18 岁');
  assert.equal(memberSexAgeLabel('male', 0), '男 · 未公开');
  assert.equal(memberSexAgeLabel('female', undefined), '女 · 未公开');
  assert.equal(memberSexAgeLabel('unknown', 0), '未公开');
  assert.equal(memberSexAgeLabel(undefined, undefined), '未公开');
});

test('group member search matches name, group card, and tag text', () => {
  const members = [
    { userId: 42, name: '小明', qqProfile: { card: '明天见' }, tags: [{ text: 'CS2', subject: '游戏', category: 'fandom' }], messageCount: 4, lastMessageTime: 100, affinity: { value: -20 } },
    { userId: 43, name: '小青', qqProfile: { card: '小雨' }, tags: [{ text: '旅行', subject: null, category: 'personality' }], messageCount: 10, lastMessageTime: 60, affinity: { value: 50 } },
    { userId: 44, name: '小林', qqProfile: null, tags: [{ text: '明日方舟', subject: null, category: 'fandom' }], messageCount: 1, lastMessageTime: 200, affinity: { value: 10 } },
  ] as const;
  const searchAndSortMembers = Reflect.get(impressionsModel, 'searchAndSortMembers') as (
    items: typeof members,
    query: string,
    sort: 'recent' | 'messages' | 'affinity',
  ) => typeof members[number][] | undefined;

  assert.equal(typeof searchAndSortMembers, 'function');
  if (typeof searchAndSortMembers !== 'function') return;
  assert.deepEqual(searchAndSortMembers(members, '小明', 'recent')?.map(({ userId }) => userId), [42]);
  assert.deepEqual(searchAndSortMembers(members, '小雨', 'recent')?.map(({ userId }) => userId), [43]);
  assert.deepEqual(searchAndSortMembers(members, 'cs2', 'recent')?.map(({ userId }) => userId), [42]);
});

test('group member search does not reveal hidden view tags', () => {
  const members = [{
    userId: 45,
    name: '小红',
    qqProfile: null,
    tags: [{ text: '主观看法', subject: null, kind: 'view' }],
    messageCount: 1,
    lastMessageTime: 1,
    affinity: { value: 0 },
  }] as const;
  const searchAndSortMembers = Reflect.get(impressionsModel, 'searchAndSortMembers') as (
    items: typeof members,
    query: string,
    sort: 'recent' | 'messages' | 'affinity',
  ) => typeof members[number][] | undefined;

  assert.deepEqual(searchAndSortMembers(members, '主观看法', 'recent'), []);
});

test('group member sorting uses recent messages, message volume, or affinity without mutating input', () => {
  const members = [
    { userId: 42, name: '小明', qqProfile: null, tags: [], messageCount: 4, lastMessageTime: 100, affinity: { value: -20 } },
    { userId: 43, name: '小青', qqProfile: null, tags: [], messageCount: 10, lastMessageTime: 60, affinity: { value: 50 } },
    { userId: 44, name: '小林', qqProfile: null, tags: [], messageCount: 1, lastMessageTime: 200, affinity: { value: 10 } },
  ] as const;
  const searchAndSortMembers = Reflect.get(impressionsModel, 'searchAndSortMembers') as (
    items: typeof members,
    query: string,
    sort: 'recent' | 'messages' | 'affinity',
  ) => typeof members[number][] | undefined;

  assert.equal(typeof searchAndSortMembers, 'function');
  if (typeof searchAndSortMembers !== 'function') return;
  assert.deepEqual(searchAndSortMembers(members, '', 'recent')?.map(({ userId }) => userId), [44, 42, 43]);
  assert.deepEqual(searchAndSortMembers(members, '', 'messages')?.map(({ userId }) => userId), [43, 42, 44]);
  assert.deepEqual(searchAndSortMembers(members, '', 'affinity')?.map(({ userId }) => userId), [43, 44, 42]);
  assert.deepEqual(members.map(({ userId }) => userId), [42, 43, 44]);
});

test('three-hour activity peak wraps midnight and chooses the first tied window', () => {
  const peakActivityWindow = Reflect.get(impressionsModel, 'peakActivityWindow') as (
    buckets: readonly number[],
  ) => { from: number; to: number; ratio: number } | undefined;
  const buckets = Array.from({ length: 24 }, () => 0);
  buckets[23] = 0.4;
  buckets[0] = 0.4;
  buckets[1] = 0.2;

  assert.equal(typeof peakActivityWindow, 'function');
  if (typeof peakActivityWindow !== 'function') return;
  assert.deepEqual(peakActivityWindow(buckets), { from: 23, to: 2, ratio: 1 });
  assert.equal(peakActivityWindow([]), undefined);
});

test('recent-tag fade label follows the supplied local fade timestamp', () => {
  assert.equal(recentTagFadeLabel({ source: 'auto', fadeAt: 6 * day + 1 }, 0), '7 天后淡出');
  assert.equal(recentTagFadeLabel({ source: 'auto', fadeAt: 0 }, 0), '已淡出');
  assert.equal(recentTagFadeLabel({ source: 'manual', fadeAt: 6 * day }, 0), undefined);
});

function impression(overrides: Partial<ViewImpression> = {}): ViewImpression {
  const id = overrides.id ?? 1;
  return {
    id,
    sessionId: '900000001:group:1004200446',
    sourceKind: 'group',
    sessionLabel: '群 1004200446',
    userId: null,
    name: '群 1004200446',
    text: `看法${id}`,
    category: 'atmosphere',
    kind: 'view',
    certain: true,
    polarity: null,
    origin: 'inferred',
    source: 'auto',
    status: 'confirmed',
    locked: false,
    ...overrides,
  };
}

test('confidence levels use the five documented lower-inclusive bands', () => {
  const confidenceLevel = Reflect.get(impressionsModel, 'confidenceLevel') as
    ((value: number) => 1 | 2 | 3 | 4 | 5) | undefined;

  assert.equal(typeof confidenceLevel, 'function');
  if (!confidenceLevel) return;
  assert.deepEqual([0, 0.3999, 0.4, 0.5999, 0.6, 0.7999, 0.8, 0.8999, 0.9, 1]
    .map(confidenceLevel), [1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
});

test('knowledge source details identify relayed account facts explicitly', () => {
  const knowledgeSourceLabel = Reflect.get(impressionsModel, 'knowledgeSourceLabel') as
    ((tag: Pick<ViewImpression, 'origin' | 'source' | 'sourceAccount'> & { samples: number }) => string) | undefined;

  assert.equal(typeof knowledgeSourceLabel, 'function');
  if (!knowledgeSourceLabel) return;
  assert.equal(knowledgeSourceLabel({ origin: 'inferred', source: 'auto', sourceAccount: 900000002, samples: 1 }), '转述 · 账号 900000002');
  assert.equal(knowledgeSourceLabel({ origin: 'stats', source: 'auto', sourceAccount: null, samples: 1 }), '统计 · 自动');
  assert.equal(knowledgeSourceLabel({ origin: 'self_report', source: 'auto', sourceAccount: null, samples: 3 }), '自述 ×3');
});

test('view-impression promotion reasons localize category names for the panel', () => {
  const localizePromotionReason = Reflect.get(impressionsModel, 'localizePromotionReason') as
    ((reason: string, category: ViewImpression['category']) => string) | undefined;

  assert.equal(typeof localizePromotionReason, 'function');
  if (!localizePromotionReason) return;
  assert.equal(
    localizePromotionReason('「atmosphere」分类表示主观看法，不适合作为知识', 'atmosphere'),
    '「氛围」分类表示主观看法，不适合作为知识',
  );
  assert.equal(localizePromotionReason('私聊来源的印象不能提升为共享知识', 'atmosphere'), '私聊来源的印象不能提升为共享知识');
});

test('personal impressions group by session and person without merging same users across sessions', () => {
  const groupPersonalImpressions = Reflect.get(impressionsModel, 'groupPersonalImpressions') as (
    tags: readonly ViewImpression[],
  ) => Array<{
    sessionId: string;
    sourceKind: 'group' | 'private' | null;
    group?: { tags: ViewImpression[] };
    people: Array<{ userId: number | null; tags: ViewImpression[] }>;
  }> | undefined;

  assert.equal(typeof groupPersonalImpressions, 'function');
  if (!groupPersonalImpressions) return;
  const result = groupPersonalImpressions([
    impression({ id: 1 }),
    impression({ id: 2, userId: 42, name: '薯条', category: 'personality' }),
    impression({ id: 3, sessionId: '900000001:group:2', sessionLabel: '群 2', userId: null, name: '群 2' }),
    impression({
      id: 4,
      sessionId: '900000001:private:42',
      sessionLabel: '私聊 薯条',
      sourceKind: 'private',
      userId: 42,
      name: '薯条',
    }),
  ]);

  assert.deepEqual(result.map((session) => ({
    sessionId: session.sessionId,
    sourceKind: session.sourceKind,
    groupIds: session.group?.tags.map(({ id }) => id) ?? [],
    people: session.people.map(({ userId, tags }) => [userId, tags.map(({ id }) => id)]),
  })), [
    { sessionId: '900000001:group:1004200446', sourceKind: 'group', groupIds: [1], people: [[42, [2]]] },
    { sessionId: '900000001:group:2', sourceKind: 'group', groupIds: [3], people: [] },
    { sessionId: '900000001:private:42', sourceKind: 'private', groupIds: [], people: [[42, [4]]] },
  ]);
});

test('personal impression rows use view categories and fold unmatched tags into other', () => {
  const personalImpressionRows = Reflect.get(impressionsModel, 'personalImpressionRows') as (
    item: { sourceKind: 'group' | 'private' | null; userId: number | null; tags: readonly ViewImpression[] },
  ) => Array<{ label: string; tags: ViewImpression[] }> | undefined;

  assert.equal(typeof personalImpressionRows, 'function');
  if (!personalImpressionRows) return;
  const memberRows = personalImpressionRows({
    sourceKind: 'group',
    userId: 42,
    tags: [
      impression({ id: 1, category: 'personality', userId: 42, name: '薯条' }),
      impression({ id: 2, category: 'speech', userId: 42, name: '薯条' }),
      impression({ id: 3, category: 'social', userId: 42, name: '薯条' }),
      impression({ id: 4, category: 'fandom', polarity: 'dislike', userId: 42, name: '薯条' }),
      impression({ id: 5, category: 'recent', userId: 42, name: '薯条' }),
      impression({ id: 6, category: 'misc', userId: 42, name: '薯条' }),
    ],
  });
  const groupRows = personalImpressionRows({
    sourceKind: 'group',
    userId: null,
    tags: [
      impression({ id: 7, category: 'atmosphere' }),
      impression({ id: 8, category: 'personality', userId: 42, name: '薯条' }),
    ],
  });

  assert.deepEqual(memberRows.map(({ label, tags }) => [label, tags.map(({ id }) => id)]), [
    ['性格', [1]],
    ['说话风格', [2]],
    ['社交方式', [3]],
    ['喜恶', [4]],
    ['其他', [5, 6]],
  ]);
  assert.deepEqual(groupRows.map(({ label, tags }) => [label, tags.map(({ id }) => id)]), [
    ['氛围', [7]],
    ['其他', [8]],
  ]);
});

test('personal impression labels include polarity and avoid duplicating an existing question mark', () => {
  const personalImpressionDisplayText = Reflect.get(impressionsModel, 'personalImpressionDisplayText') as
    ((tag: Pick<ViewImpression, 'text' | 'certain' | 'polarity'>) => { text: string; showQuestion: boolean; title: string }) | undefined;

  assert.equal(typeof personalImpressionDisplayText, 'function');
  if (!personalImpressionDisplayText) return;
  assert.deepEqual(personalImpressionDisplayText({ text: '靠得住', certain: false, polarity: 'dislike' }), {
    text: '靠得住 · 不喜欢', showQuestion: true, title: '靠得住 · 不喜欢?',
  });
  assert.deepEqual(personalImpressionDisplayText({ text: '可能喜欢?', certain: false, polarity: 'like' }), {
    text: '可能喜欢? · 喜欢', showQuestion: false, title: '可能喜欢? · 喜欢',
  });
});
