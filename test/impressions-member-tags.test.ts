import assert from 'node:assert/strict';
import test from 'node:test';
import type { StoredTag } from '../src/store/affect-repo.ts';
import { buildMemberTagPrompt, formatMemberTags } from '../src/core/impressions/member-tags.ts';

const now = 1_800_000_000_000;

function tag(overrides: Partial<StoredTag> = {}): StoredTag {
  return {
    id: 1,
    account: 900000001,
    sessionId: '900000001:group:123456',
    userId: 42,
    text: '标签',
    norm: '标签',
    category: 'personality',
    subject: null,
    polarity: null,
    origin: 'inferred',
    locked: false,
    status: 'confirmed',
    source: 'auto',
    samples: 2,
    evidence: [],
    firstSeen: now,
    lastSeen: now,
    supersededBy: null,
    updatedAt: now,
    ...overrides,
  };
}

test('群友标签按规定分组顺序格式化为快照文本', () => {
  const rendered = formatMemberTags([
    tag({ id: 1, category: 'social', text: '熟人慢热' }),
    tag({ id: 2, category: 'identity', text: 'INTP', origin: 'inferred' }),
    tag({ id: 3, category: 'fandom', text: '原神', subject: '游戏', polarity: 'dislike' }),
    tag({ id: 4, category: 'speech', text: '简短' }),
    tag({ id: 5, category: 'recent', text: '准备搬家' }),
    tag({ id: 6, category: 'identity', text: 'INFJ', origin: 'self_report', firstSeen: now - 1_000 }),
    tag({ id: 7, category: 'schedule', text: '夜猫子' }),
    tag({ id: 8, category: 'personality', text: '慢热' }),
    tag({ id: 9, category: 'fandom', text: '守望先锋', subject: '游戏', polarity: 'like' }),
    tag({ id: 10, category: 'dislike', text: '讨厌被催' }),
    tag({ id: 11, category: 'identity', text: 'INTJ', origin: 'self_report', firstSeen: now - 2_000 }),
    tag({ id: 12, category: 'fandom', text: 'CS2', subject: '游戏', polarity: 'like' }),
  ]);

  assert.equal(
    rendered,
    '雷点：讨厌被催；性格：慢热；成分：游戏（守望先锋/CS2，不喜欢原神）；'
      + '自称在 INTJ/INFJ 间摇摆、（推测，仅供参考，别据此下结论）INTP；'
      + '近况：准备搬家；作息：夜猫子；说话风格：简短、社交方式：熟人慢热',
  );
});

test('单个 confirmed self_report identity 写成自称格式', () => {
  assert.equal(
    formatMemberTags([tag({ id: 13, category: 'identity', text: 'INTJ', origin: 'self_report' })]),
    '自称 INTJ',
  );
});

test('成员提示筛除 locked、misc 与未确认的 inferred identity', () => {
  const result = buildMemberTagPrompt([
    tag({ id: 1, category: 'personality', text: '私人标签', locked: true }),
    tag({ id: 2, category: 'misc', text: '未分类' }),
    tag({ id: 3, category: 'identity', text: 'ENFP', status: 'candidate' }),
    tag({ id: 4, category: 'schedule', text: '夜猫子' }),
  ], now);

  assert.deepEqual(result, { text: '作息：夜猫子', dropped: 0 });
});

test('超过 160 字时从末尾的组开始丢弃并计数', () => {
  const long = '夜'.repeat(30);
  const result = buildMemberTagPrompt([
    tag({ id: 1, category: 'dislike', text: long }),
    tag({ id: 2, category: 'personality', text: long }),
    tag({ id: 3, category: 'recent', text: long }),
    tag({ id: 4, category: 'schedule', text: long }),
    tag({ id: 5, category: 'speech', text: long }),
  ], now);

  assert.ok(Array.from(result.text).length <= 160);
  assert.equal(result.text.includes('说话风格'), false);
  assert.equal(result.dropped, 1);
});
