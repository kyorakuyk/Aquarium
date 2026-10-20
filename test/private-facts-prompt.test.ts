import assert from 'node:assert/strict';
import test from 'node:test';
import { createMessagePipeline } from '../src/core/conversation/pipeline.ts';
import type { SessionKey } from '../src/core/shared/events.ts';
import { promptTemplateStore } from '../src/core/prompt/templates.ts';
import { createPrivateFactsService } from '../src/core/privacy/service.ts';
import type { PrivateFactRecord } from '../src/store/privacy-repo.ts';
import { FakeAdapter, groupSession, makeConfig, makeIncoming, withRepository } from './pipeline-test-helpers.ts';

type PrivateSession = { account: number; kind: 'private'; peer: number };

const now = new Date(2026, 9, 20, 10, 0).getTime();
const ownerId = 42;
const privateSession: PrivateSession = { account: groupSession.account, kind: 'private', peer: ownerId };
const privateSessionId = `${privateSession.account}:private:${ownerId}`;
const template = promptTemplateStore.get().replySystem;

function fact(input: {
  ownerId: number;
  sessionId: string;
  text: string;
  level?: 'L0' | 'L1' | 'L2';
  updatedAt?: number;
}): Omit<PrivateFactRecord, 'id'> {
  return {
    account: groupSession.account,
    ownerId: input.ownerId,
    sessionId: input.sessionId,
    text: input.text,
    keywords: ['事实', '记忆'],
    level: input.level ?? 'L0',
    levelSource: 'auto',
    mentions: 0,
    mentionEvidence: [],
    evidence: [],
    status: 'active',
    createdAt: input.updatedAt ?? now,
    updatedAt: input.updatedAt ?? now,
  };
}

function promptBlockMethod(service: unknown): (input: {
  session: SessionKey;
  name: string;
  now: number;
  template: typeof template;
}) => string | undefined {
  const method = Reflect.get(service, 'promptBlock');
  assert.equal(typeof method, 'function');
  return method as (input: {
    session: SessionKey;
    name: string;
    now: number;
    template: typeof template;
  }) => string | undefined;
}

test('private prompt facts obey scope policy and append same-person group tags last', async () => {
  await withRepository(async (repository) => {
    repository.insertPrivateFact(fact({
      ownerId,
      sessionId: privateSessionId,
      text: '当前私聊记忆',
      level: 'L0',
      updatedAt: now - 1,
    }));
    repository.insertPrivateFact(fact({
      ownerId,
      sessionId: `${privateSession.account}:private:42:other`,
      text: '其他私聊高等级事实',
      level: 'L2',
      updatedAt: now,
    }));
    repository.insertPrivateFact(fact({
      ownerId,
      sessionId: `${privateSession.account}:private:42:third`,
      text: '另一私聊低等级事实',
      level: 'L0',
      updatedAt: now + 1,
    }));
    const insertTag = (sessionId: string, userId: number, text: string) => repository.insertTag({
      account: groupSession.account,
      sessionId,
      userId,
      text,
      norm: text,
      category: 'schedule',
      subject: null,
      polarity: null,
      origin: 'manual',
      locked: false,
      status: 'confirmed',
      source: 'manual',
      samples: 1,
      evidence: [],
      firstSeen: now,
      lastSeen: now,
      supersededBy: null,
      updatedAt: now,
    });
    insertTag(`${groupSession.account}:group:1001`, ownerId, '夜猫子');
    insertTag(`${groupSession.account}:group:1001`, 43, '别人的标签');
    insertTag(privateSessionId, ownerId, '私聊标签表记录');

    const service = createPrivateFactsService({ repository, getConfig: makeConfig });
    const block = promptBlockMethod(service)({ session: privateSession, name: '小明', now, template });

    assert.ok(block);
    const sameSessionIndex = block.indexOf('当前私聊记忆');
    const groupTagIndex = block.indexOf('夜猫子');
    assert.ok(sameSessionIndex >= 0 && sameSessionIndex < groupTagIndex, block);
    assert.equal(block.includes('其他私聊高等级事实'), false);
    assert.equal(block.includes('另一私聊低等级事实'), false);
    assert.equal(block.includes('别人的标签'), false);
    assert.equal(block.includes('私聊标签表记录'), false);
    assert.ok(block.startsWith('你和"小明"私聊时了解到：'));
    assert.ok(block.endsWith('（自然地记得就好，不要逐条复述）'));
    assert.equal(promptBlockMethod(service)({ session: groupSession, name: '小明', now, template }), undefined);
  });
});

test('private prompt facts limit the combined block to six entries and 200 characters', async () => {
  await withRepository(async (repository) => {
    for (let index = 0; index < 7; index += 1) {
      repository.insertPrivateFact(fact({
        ownerId,
        sessionId: privateSessionId,
        text: `短事实${String(index + 1)}`,
        updatedAt: now - index,
      }));
    }
    const longOwnerId = 43;
    const longSessionId = `${groupSession.account}:private:${longOwnerId}`;
    for (let index = 0; index < 6; index += 1) {
      repository.insertPrivateFact(fact({
        ownerId: longOwnerId,
        sessionId: longSessionId,
        text: `${index + 1}${'甲'.repeat(39)}`,
        updatedAt: now - index,
      }));
    }
    const service = createPrivateFactsService({ repository, getConfig: makeConfig });
    const promptBlock = promptBlockMethod(service);
    const shortBlock = promptBlock({ session: privateSession, name: '小明', now, template });
    assert.ok(shortBlock);
    const shortFacts = shortBlock.split('：')[1]!.split('（自然地记得就好')[0]!;
    assert.equal(shortFacts.split('；').length, 6);

    const longBlock = promptBlock({
      session: { account: groupSession.account, kind: 'private', peer: longOwnerId },
      name: '小红',
      now,
      template,
    });
    assert.ok(longBlock);
    const longFacts = longBlock.split('：')[1]!.split('（自然地记得就好')[0]!;
    assert.equal(Array.from(longFacts).length, 163);
    assert.ok(Array.from(longFacts).length <= 200);
    assert.equal(longFacts.split('；').length, 4);
  });
});

test('context injects the privateFacts block into a real private reply prompt', async () => {
  await withRepository(async (repository, personaRoot) => {
    repository.insertPrivateFact(fact({
      ownerId,
      sessionId: privateSessionId,
      text: '喜欢清晨散步',
      updatedAt: now,
    }));
    repository.insertTag({
      account: groupSession.account,
      sessionId: `${groupSession.account}:group:1001`,
      userId: ownerId,
      text: '夜猫子',
      norm: '夜猫子',
      category: 'schedule',
      subject: null,
      polarity: null,
      origin: 'manual',
      locked: false,
      status: 'confirmed',
      source: 'manual',
      samples: 1,
      evidence: [],
      firstSeen: now,
      lastSeen: now,
      supersededBy: null,
      updatedAt: now,
    });
    repository.insertTag({
      account: groupSession.account,
      sessionId: `${groupSession.account}:group:1001`,
      userId: ownerId,
      text: 'INTP',
      norm: 'intp',
      category: 'identity',
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
    });
    const config = makeConfig();
    const privateFactsService = createPrivateFactsService({ repository, getConfig: () => config });
    const adapter = new FakeAdapter();
    const prompts: string[] = [];
    const pipeline = createMessagePipeline({
      getConfig: () => config,
      repository,
      adapter,
      getNickname: () => adapter.nickname,
      personaRoot,
      privateFactsService,
      now: () => now,
      wait: async () => {},
      random: () => 0.5,
      callModel: async (_slot, messages) => {
        prompts.push(messages.map((message) => String(message.content)).join('\n'));
        return {
          text: '收到。',
          provider: 'fake',
          model: 'fake-model',
          usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
        };
      },
    });

    const result = await pipeline(makeIncoming({
      session: privateSession,
      messageId: 'private-reply',
      senderId: ownerId,
      plainText: '今天过得怎么样？',
      time: now,
    }));

    assert.equal(result.replied, true);
    assert.ok(prompts[0]?.includes(`你和"小明"私聊时了解到：喜欢清晨散步；（推测，仅供参考，别据此下结论）INTP；作息：夜猫子`));
    assert.ok(prompts[0]?.includes('（推测，仅供参考，别据此下结论）INTP'));
    const detail = repository.recentDecisions(1)[0]?.detail as {
      promptBlocks?: Array<{ id: string }>;
    };
    assert.ok(detail.promptBlocks?.some(({ id }) => id === 'privateFacts'));
  });
});
