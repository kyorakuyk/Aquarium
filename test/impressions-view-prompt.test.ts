import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPromptMessages, describePromptBlocks, type BuildPromptOptions } from '../src/core/prompt/index.ts';
import type { ReplySystemTemplate } from '../src/core/prompt/templates.ts';
import { createImpressionsService } from '../src/core/impressions/service.ts';
import { sessionId, type SessionKey } from '../src/core/shared/events.ts';
import { promptTemplateStore } from '../src/core/prompt/templates.ts';
import type { StoreRepository } from '../src/store/repository.ts';
import { groupSession, makeConfig, withRepository } from './pipeline-test-helpers.ts';

const now = Date.UTC(2026, 9, 21, 12);
const account = groupSession.account;
const currentMember = 42;
const anotherMember = 43;
const impressionsTemplate = '以下是你个人的看法，带 ? 的不确定，可与他人不同：{{tags}}';

function addView(
  repository: StoreRepository,
  input: {
    text: string;
    sessionId: string;
    userId?: number | null;
    kind?: 'view' | 'fact';
    category?: 'personality' | 'misc';
    samples?: number;
    status?: 'candidate' | 'confirmed';
    locked?: boolean;
    manual?: boolean;
  },
): number {
  return repository.insertTag({
    account,
    sessionId: input.sessionId,
    userId: input.userId ?? null,
    text: input.text,
    norm: input.text.toLowerCase(),
    kind: input.kind ?? 'view',
    category: input.category ?? 'personality',
    subject: null,
    polarity: null,
    origin: input.manual ? 'manual' : 'inferred',
    locked: input.locked ?? false,
    status: input.status ?? 'confirmed',
    source: input.manual ? 'manual' : 'auto',
    samples: input.samples ?? 2,
    evidence: [],
    firstSeen: now - 1_000,
    lastSeen: now,
    supersededBy: null,
    updatedAt: now,
  });
}

function promptService(repository: StoreRepository) {
  return createImpressionsService({
    repository,
    getConfig: () => makeConfig({ nicknames: [] }),
    now: () => now,
    callModel: async () => ({
      text: '{}',
      provider: 'fake',
      model: 'fake-model',
      usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, costCny: 0 },
    }),
  });
}

test('view 印象标注确定性且重复注入稳定', async () => {
  await withRepository((repository) => {
    const key = sessionId(groupSession);
    addView(repository, { text: '喜欢猫', sessionId: key, samples: 2 });
    addView(repository, { text: '尊重边界', sessionId: key, samples: 1, manual: true });
    addView(repository, { text: '特别看法', sessionId: key, category: 'misc' });
    const service = promptService(repository);
    const input = {
      session: groupSession,
      sessionId: key,
      senderId: currentMember,
      senderName: '小明',
      now,
      template: {
        ...promptTemplateStore.get().replySystem,
        impressions: impressionsTemplate,
      } as ReplySystemTemplate,
    };

    const first = service.promptBlocks(input) as { impressions?: string };
    const second = service.promptBlocks(input) as { impressions?: string };
    assert.equal(first.impressions, second.impressions);
    assert.match(first.impressions ?? '', /^以下是你个人的看法，带 \? 的不确定，可与他人不同/u);
    assert.match(first.impressions ?? '', /喜欢猫\?/u);
    assert.match(first.impressions ?? '', /尊重边界/u);
    assert.match(first.impressions ?? '', /特别看法\?/u);
    assert.doesNotMatch(first.impressions ?? '', /尊重边界\?/u);
    assert.ok((first.impressions ?? '').indexOf('特别看法?') < (first.impressions ?? '').indexOf('喜欢猫?'));
    assert.ok((first.impressions ?? '').indexOf('喜欢猫?') < (first.impressions ?? '').indexOf('尊重边界'));
    const tags = repository.listViewTagsForAccount(account);
    assert.ok(tags.every((tag) => tag.inPrompt));
  });
});

test('view 印象排除非确认、锁定、其他成员与 L0 私聊来源', async () => {
  await withRepository((repository) => {
    const key = sessionId(groupSession);
    const privateSession: SessionKey = { account, kind: 'private', peer: currentMember };
    addView(repository, { text: '当前成员看法', sessionId: key, userId: currentMember });
    addView(repository, { text: '候选条目', sessionId: key, status: 'candidate' });
    addView(repository, { text: '锁定条目', sessionId: key, locked: true });
    addView(repository, { text: '其他成员条目', sessionId: key, userId: anotherMember });
    const privateTagId = addView(repository, {
      text: '私聊 L0 条目', sessionId: sessionId(privateSession), userId: currentMember,
    });
    repository.updateTag(privateTagId, { inPrompt: true });
    addView(repository, { text: '事实标签', sessionId: key, kind: 'fact' });
    const blocks = promptService(repository).promptBlocks({
      session: groupSession,
      sessionId: key,
      senderId: currentMember,
      senderName: '小明',
      now,
      template: {
        ...promptTemplateStore.get().replySystem,
        impressions: impressionsTemplate,
      } as ReplySystemTemplate,
    }) as { impressions?: string };

    assert.match(blocks.impressions ?? '', /当前成员看法\?/u);
    for (const excluded of ['候选条目', '锁定条目', '其他成员条目', '私聊 L0 条目', '事实标签']) {
      assert.doesNotMatch(blocks.impressions ?? '', new RegExp(excluded, 'u'));
    }
    assert.equal(repository.tagById(privateTagId)?.inPrompt, true);
  });
});

test('印象块排在 groupTags 与 memberTags 知识块之后', () => {
  const template = {
    ...promptTemplateStore.get().replySystem,
    impressions: impressionsTemplate,
  } as ReplySystemTemplate;
  const options = {
    persona: 'persona',
    ownerId: 0,
    groupNote: '',
    context: [],
    replySystemTemplate: template,
    blocks: {
      groupTags: 'group knowledge',
      memberTags: 'member knowledge',
      impressions: 'personal impressions',
    },
  } as unknown as BuildPromptOptions;
  const ids = describePromptBlocks(options).map(({ id }) => id);
  assert.ok(ids.indexOf('groupTags') < ids.indexOf('memberTags'));
  assert.ok(ids.indexOf('memberTags') < ids.indexOf('impressions'));
  const messages = buildPromptMessages(options);
  assert.ok(String(messages[1]?.content).indexOf('member knowledge')
    < String(messages[1]?.content).indexOf('personal impressions'));
});
