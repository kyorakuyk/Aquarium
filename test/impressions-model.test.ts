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
