import assert from 'node:assert/strict';
import test from 'node:test';
import type { StoredTag } from '../src/store/affect-repo.ts';
import { createImpressionsService } from '../src/core/impressions/service.ts';
import { promptTemplateStore } from '../src/core/prompt/templates.ts';
import { sessionId } from '../src/core/shared/events.ts';
import { GROUP_TAGS_LIMIT, selectInjectableTags, tagHalfLifeMs } from '../src/core/impressions/tags.ts';
import { createRepository } from '../src/store/repository.ts';
import { groupSession, makeConfig, withRepository } from './pipeline-test-helpers.ts';

const now = Date.UTC(2026, 9, 22, 12);
type StatefulTag = StoredTag & { inPrompt: boolean };

function statefulTag(overrides: Partial<StatefulTag> = {}): StatefulTag {
  return {
    id: 1,
    account: 900000001,
    sessionId: '900000001:group:123456',
    userId: null,
    text: '标签',
    norm: '标签',
    category: 'positioning',
    kind: 'fact',
    subject: null,
    polarity: null,
    origin: 'inferred',
    locked: false,
    status: 'confirmed',
    source: 'auto',
    samples: 1,
    evidence: [],
    firstSeen: now,
    lastSeen: now,
    supersededBy: null,
    updatedAt: now,
    inPrompt: false,
    certain: false,
    ...overrides,
  };
}

function tagAtActivation(activation: number, overrides: Partial<StatefulTag> = {}): StatefulTag {
  const base = statefulTag(overrides);
  const halfLife = tagHalfLifeMs(base);
  return halfLife === null
    ? { ...base, lastSeen: now }
    : { ...base, lastSeen: now + halfLife * Math.log2(activation) };
}

test('置信度在 0.35 与 0.5 之间时保持 in_prompt 原状态', () => {
  const off = tagAtActivation(0.4, { id: 1, inPrompt: false });
  const on = tagAtActivation(0.4, { id: 2, inPrompt: true });

  const selected = selectInjectableTags([off, on], now, GROUP_TAGS_LIMIT);

  assert.deepEqual(selected.tags.map(({ id }) => id), [2]);
  assert.deepEqual(selected.stateUpdates, []);
});

test('跨过迟滞阈值才翻转 in_prompt 状态', () => {
  const enters = tagAtActivation(0.5, { id: 1, inPrompt: false });
  const exits = tagAtActivation(0.35, { id: 2, inPrompt: true });

  const selected = selectInjectableTags([enters, exits], now, GROUP_TAGS_LIMIT);

  assert.deepEqual(selected.tags.map(({ id }) => id), [1]);
  assert.deepEqual(selected.stateUpdates, [
    { id: 1, inPrompt: true },
    { id: 2, inPrompt: false },
  ]);
});

test('manual 标签不受置信度阈值排除', () => {
  const manual = tagAtActivation(0.2, {
    id: 1,
    origin: 'manual',
    source: 'auto',
    inPrompt: false,
  });

  const selected = selectInjectableTags([manual], now, GROUP_TAGS_LIMIT);

  assert.deepEqual(selected.tags.map(({ id }) => id), [1]);
  assert.deepEqual(selected.stateUpdates, [{ id: 1, inPrompt: true }]);
});

test('容量冲突时同置信度下优先保留 manual 标签', () => {
  const manual = tagAtActivation(1, { id: 1, origin: 'manual', category: 'positioning', norm: '手动' });
  const automatic = tagAtActivation(1, { id: 2, origin: 'inferred', category: 'topic', norm: '自动' });

  const selected = selectInjectableTags([manual, automatic], now, { max: 1, maxChars: 120 });

  assert.deepEqual(selected.tags.map(({ id }) => id), [1]);
  assert.deepEqual(selected.stateUpdates, [{ id: 1, inPrompt: true }]);
});

test('超限先丢弃置信度最低的条目，入选后按 category 和 norm 排序', () => {
  const tags = [
    tagAtActivation(0.9, { id: 1, category: 'topic', text: '话题乙', norm: '话题乙' }),
    tagAtActivation(0.95, { id: 2, category: 'positioning', text: '定位乙', norm: '定位乙' }),
    tagAtActivation(0.7, { id: 3, category: 'norms', text: '规矩乙', norm: '规矩乙', inPrompt: true }),
  ];

  const selected = selectInjectableTags(tags, now, { max: 2, maxChars: 120 });

  assert.deepEqual(selected.tags.map(({ id }) => id), [2, 1]);
  assert.equal(selected.dropped, 1);
  assert.deepEqual(selected.stateUpdates, [
    { id: 1, inPrompt: true },
    { id: 2, inPrompt: true },
    { id: 3, inPrompt: false },
  ]);
});

test('同一数据连续构造提示词字节级一致并保存 in_prompt', async () => {
  await withRepository(async (repository) => {
    const key = sessionId(groupSession);
    const groupTagId = repository.insertTag({
      account: groupSession.account,
      sessionId: key,
      userId: null,
      text: '群内规则',
      norm: '群内规则',
      category: 'positioning',
      subject: null,
      polarity: null,
      origin: 'inferred',
      locked: false,
      status: 'confirmed',
      source: 'auto',
      samples: 1,
      evidence: [],
      firstSeen: now,
      lastSeen: now,
      supersededBy: null,
      updatedAt: now,
    });
    const memberTagId = repository.insertTag({
      account: groupSession.account,
      sessionId: key,
      userId: 42,
      text: '夜猫子',
      norm: '夜猫子',
      category: 'schedule',
      subject: null,
      polarity: null,
      origin: 'self_report',
      locked: false,
      status: 'confirmed',
      source: 'auto',
      samples: 1,
      evidence: [],
      firstSeen: now,
      lastSeen: now,
      supersededBy: null,
      updatedAt: now,
    });
    const service = createImpressionsService({
      repository,
      getConfig: () => makeConfig(),
      now: () => now,
    });
    const input = {
      session: groupSession,
      sessionId: key,
      senderId: 42,
      senderName: '群友',
      now,
      template: promptTemplateStore.get().replySystem,
    };

    const first = service.promptBlocks(input);
    const second = service.promptBlocks(input);

    assert.deepEqual(second, first);
    assert.match(first.groupTags ?? '', /群内规则/u);
    assert.match(first.memberTags ?? '', /夜猫子/u);
    const storedGroupTag = repository.tagById(groupTagId);
    const storedMemberTag = repository.tagById(memberTagId);
    assert.equal(storedGroupTag && Reflect.get(storedGroupTag, 'inPrompt'), true);
    assert.equal(storedMemberTag && Reflect.get(storedMemberTag, 'inPrompt'), true);
    assert.doesNotMatch(JSON.stringify(first), /置信度|0\.\d{2}/u);
  });
});
