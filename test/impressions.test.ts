import assert from 'node:assert/strict';
import test from 'node:test';
import type { StoredTag, TagEvidence } from '../src/store/affect-repo.ts';
import { tagKindFor } from '../src/core/impressions/tag-model.ts';
import {
  ACTIVATION_MIN,
  applyTagContradiction,
  applyTagObservation,
  GROUP_TAG_HALF_LIFE_MS,
  GROUP_TAGS_LIMIT,
  MEMBER_TAG_HALF_LIFE_MS,
  MEMBER_TAGS_LIMIT,
  normalizeTagText,
  selectInjectableTags,
  tagActivation,
} from '../src/core/impressions/tags.ts';

const dayMs = 24 * 60 * 60 * 1000;

function tag(overrides: Partial<StoredTag> = {}): StoredTag {
  const record: StoredTag = {
    id: 1,
    account: 900000001,
    sessionId: '900000001:group:123456',
    userId: 42,
    text: '爱聊游戏',
    norm: '爱聊游戏',
    category: 'misc',
    subject: null,
    polarity: null,
    origin: 'inferred',
    locked: false,
    kind: 'view',
    inPrompt: false,
    certain: false,
    status: 'candidate',
    source: 'auto',
    samples: 1,
    evidence: [],
    firstSeen: 0,
    lastSeen: 0,
    supersededBy: null,
    updatedAt: 0,
    ...overrides,
  };
  return { ...record, kind: tagKindFor(record.category, record.polarity) };
}

test('观察只统计新的证据消息并更新 last_seen，重复 messageId 不计数', () => {
  const existing = tag({
    samples: 1,
    lastSeen: 1_000,
    evidence: [{ messageId: 'm1', time: 1_000, quote: '第一句' }],
  });

  const observed = applyTagObservation([existing], {
    text: '爱聊游戏',
    messageId: 'm2',
    time: 2_000,
    quote: '第二句',
  });
  assert.equal(observed.action, 'observe');
  if (observed.action !== 'observe') return;
  assert.equal(observed.id, 1);
  assert.equal(observed.samples, 2);
  assert.equal(observed.lastSeen, 2_000);
  assert.deepEqual(observed.evidence
    .filter((item) => item.kind !== 'signature')
    .map((item) => item.messageId), ['m1', 'm2']);

  const duplicate = applyTagObservation([existing], {
    text: '爱聊游戏',
    messageId: 'm1',
    time: 3_000,
    quote: '重复证据',
  });
  assert.deepEqual(duplicate, { action: 'ignore', reason: 'duplicate' });
});

test('candidate 达到两次独立观察后自动转正，confirmed 保持 confirmed', () => {
  const candidate = tag({ status: 'candidate', samples: 1 });
  const confirmed = applyTagObservation([candidate], {
    text: '爱聊游戏', messageId: 'm2', time: 2_000, quote: '',
  });
  assert.equal(confirmed.action, 'observe');
  assert.equal(confirmed.action === 'observe' ? confirmed.status : '', 'confirmed');

  const promoted = tag({ status: 'confirmed', samples: 2 });
  const again = applyTagObservation([promoted], {
    text: '爱聊游戏', messageId: 'm3', time: 3_000, quote: '',
  });
  assert.equal(again.action, 'observe');
  assert.equal(again.action === 'observe' ? again.status : '', 'confirmed');
  assert.equal(again.action === 'observe' ? again.samples : 0, 3);
});

test('新增判重：同主语同 norm 的 rejected 与 superseded 不复活，其他状态按观察处理', () => {
  const rejected = tag({ id: 7, status: 'rejected', norm: normalizeTagText('爱聊游戏') });
  assert.deepEqual(
    applyTagObservation([rejected], { text: '爱聊游戏', messageId: 'm9', time: 9_000, quote: '' }),
    { action: 'ignore', reason: 'no_revival' },
  );

  const superseded = tag({ id: 8, status: 'superseded', norm: '爱聊游戏', supersededBy: 9 });
  assert.deepEqual(
    applyTagObservation([superseded], { text: '爱聊游戏', messageId: 'm9', time: 9_000, quote: '' }),
    { action: 'ignore', reason: 'no_revival' },
  );

  const fresh = applyTagObservation([], {
    text: ' 爱聊“游戏”！ ', messageId: 'm10', time: 10_000, quote: '证据',
  });
  assert.equal(fresh.action, 'insert');
  if (fresh.action !== 'insert') return;
  assert.equal(fresh.norm, '爱聊游戏');
  assert.equal(fresh.text, ' 爱聊“游戏”！ ');
  assert.deepEqual(fresh.evidence, [{ messageId: 'm10', time: 10_000, quote: '证据' }]);
});

test('推翻只针对 auto 标签：manual 目标丢弃，缺失 id 忽略', () => {
  const auto = tag({ id: 3, source: 'auto' });
  const outcome = applyTagContradiction([auto], {
    id: 3, text: '其实不聊游戏', messageId: 'm4', time: 4_000, quote: '只看文档',
  });
  assert.equal(outcome.action, 'insert');
  if (outcome.action !== 'insert') return;
  assert.equal(outcome.supersedes, 3);
  assert.equal(outcome.norm, '其实不聊游戏');

  const manual = tag({ id: 4, source: 'manual', origin: 'manual' });
  assert.deepEqual(
    applyTagContradiction([manual], { id: 4, text: '推翻', messageId: 'm5', time: 5_000, quote: '' }),
    { action: 'ignore', reason: 'manual_target' },
  );
  assert.deepEqual(
    applyTagContradiction([auto], { id: 99, text: '推翻', messageId: 'm6', time: 6_000, quote: '' }),
    { action: 'ignore', reason: 'not_found' },
  );
});

test('激活度按半衰期与 samples 计算，manual 恒为 1', () => {
  const now = 100 * dayMs;
  const member = tag({ userId: 42, samples: 2, lastSeen: now - MEMBER_TAG_HALF_LIFE_MS });
  assert.ok(Math.abs(tagActivation(member, now) - 0.5) < 1e-12);

  const frequent = tag({ userId: 42, samples: 4, lastSeen: now - MEMBER_TAG_HALF_LIFE_MS });
  assert.ok(Math.abs(tagActivation(frequent, now) - 2 ** (-1 / 3)) < 1e-12);

  const group = tag({ userId: null, samples: 1, lastSeen: now - GROUP_TAG_HALF_LIFE_MS });
  assert.ok(Math.abs(tagActivation(group, now) - 0.5) < 1e-12);

  const manual = tag({ source: 'manual', origin: 'manual', lastSeen: now - 365 * dayMs });
  assert.equal(tagActivation(manual, now), 1);
});

test('画像类别决定半衰期；schedule 不衰减', () => {
  const now = 200 * dayMs;
  const identity = tag({ category: 'identity', lastSeen: now - 180 * dayMs });
  const recent = tag({ category: 'recent', lastSeen: now - 3 * dayMs });
  const dislike = tag({ category: 'dislike', lastSeen: now - 60 * dayMs });
  const atmosphere = tag({ category: 'atmosphere', userId: null, lastSeen: now - 14 * dayMs });
  const schedule = tag({ category: 'schedule', lastSeen: now - 365 * dayMs });

  assert.equal(tagActivation(identity, now), 0.5);
  assert.equal(tagActivation(recent, now), 0.5);
  assert.equal(tagActivation(dislike, now), 0.5);
  assert.equal(tagActivation(atmosphere, now), 0.5);
  assert.equal(tagActivation(schedule, now), 1);
});

test('注入选择跨过迟滞阈值后按 category 与 norm 稳定排序', () => {
  const now = 100 * dayMs;
  const tags = [
    tag({ id: 1, category: 'personality', status: 'candidate', samples: 5, lastSeen: now }),
    tag({ id: 2, category: 'personality', status: 'confirmed', samples: 2, lastSeen: now - 65 * dayMs }),
    tag({ id: 3, category: 'personality', status: 'confirmed', samples: 2, lastSeen: now }),
    tag({ id: 4, category: 'personality', status: 'confirmed', source: 'manual', origin: 'manual', samples: 1, lastSeen: now - 10 * dayMs }),
    tag({ id: 5, category: 'personality', status: 'confirmed', samples: 3, lastSeen: now - dayMs }),
  ];

  const selected = selectInjectableTags(tags, now, GROUP_TAGS_LIMIT);

  assert.deepEqual(selected.tags.map((item) => item.id), [3, 4, 5]);
  assert.equal(selected.dropped, 0);
  assert.ok(tagActivation(tags[1] as StoredTag, now) < ACTIVATION_MIN);
});

test('注入选择遵守数量与总长上限并记录丢弃数', () => {
  const now = 100 * dayMs;
  const many = Array.from({ length: 8 }, (_, index) => tag({
    id: index + 1,
    category: 'personality',
    status: 'confirmed',
    samples: 5,
    lastSeen: now - index * 1_000,
    text: `标签-${index + 1}`,
  }));

  const group = selectInjectableTags(many, now, GROUP_TAGS_LIMIT);
  assert.equal(group.tags.length, 6);
  assert.equal(group.dropped, 2);

  const long = Array.from({ length: 3 }, (_, index) => tag({
    id: index + 11,
    category: 'personality',
    status: 'confirmed',
    samples: 5,
    lastSeen: now - index * 1_000,
    text: '很长的标签'.repeat(25),
  }));
  const member = selectInjectableTags(long, now, MEMBER_TAGS_LIMIT);
  assert.equal(member.tags.length, 1);
  assert.equal(member.dropped, 2);
});

test('注入选择不返回 locked 或 misc 标签', () => {
  const now = 100 * dayMs;
  const selected = selectInjectableTags([
    tag({ category: 'personality', status: 'confirmed', locked: true, lastSeen: now }),
    tag({ id: 2, category: 'misc', status: 'confirmed', lastSeen: now }),
  ], now, GROUP_TAGS_LIMIT);

  assert.deepEqual(selected, { tags: [], dropped: 0, stateUpdates: [] });
});
