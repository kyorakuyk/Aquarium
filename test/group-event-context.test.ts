import assert from 'node:assert/strict';
import test from 'node:test';
import type { QqProfileActions } from '../src/adapters/types.ts';
import { resolveSession } from '../src/config/resolve.ts';
import { createAnchoredContextWindow } from '../src/core/conversation/context-window.ts';
import { contextStep } from '../src/core/conversation/steps/context.ts';
import type { StepContext } from '../src/core/conversation/steps/types.ts';
import { createQqProfileService } from '../src/core/profiles/qq-profile-service.ts';
import { sessionId, type SessionKey } from '../src/core/shared/events.ts';
import { promptTemplateStore } from '../src/core/prompt/templates.ts';
import { createRateLimiter } from '../src/core/shared/rate-limit.ts';
import type { StoreRepository } from '../src/store/repository.ts';
import type { SlotResult } from '../src/llm/slots.ts';
import { baseTime, FakeAdapter, groupSession, makeConfig, makeIncoming, withRepository } from './pipeline-test-helpers.ts';

const GROUP_A = 80;
const GROUP_B = 81;
const MEMBER_A = 42;
const MEMBER_B = 43;

function addEvent(
  repository: StoreRepository,
  input: { groupId: number; anchor: string; title: string; summary: string; hoursAgo: number },
): void {
  const occurredAt = baseTime - input.hoursAgo * 60 * 60_000;
  repository.upsertGroupEvent({
    account: groupSession.account,
    sourceGroupId: input.groupId,
    anchorMessageId: input.anchor,
    title: input.title,
    summary: input.summary,
    participantIds: [MEMBER_A],
    evidenceMessageIds: [input.anchor],
    occurredAt,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  });
}

async function loadMemberCaches(repository: StoreRepository): Promise<void> {
  const adapter = new FakeAdapter();
  Object.defineProperty(adapter, 'getGroupMembers', {
    value: async (groupId: number) => [{
      userId: groupId === GROUP_A ? MEMBER_A : MEMBER_B,
      nickname: '测试群友',
    }],
  });
  const service = createQqProfileService({ repository, now: () => baseTime });
  for (const groupId of [GROUP_A, GROUP_B]) {
    await service.readGroup({ account: groupSession.account, groupId, adapter: adapter as QqProfileActions });
  }
}

function makeContext(
  repository: StoreRepository,
  personaRoot: string,
  peerId: number,
  plainText: string,
): StepContext {
  const session: SessionKey = { account: groupSession.account, kind: 'private', peer: peerId };
  const config = makeConfig({ nicknames: [] });
  const modelCall = async (): Promise<SlotResult> => ({
    text: '回复',
    provider: 'fake',
    model: 'fake-model',
    usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, costCny: 0 },
  });
  const adapter = new FakeAdapter();
  return {
    message: makeIncoming({ session, senderId: peerId, plainText, time: baseTime }),
    processOptions: {},
    currentSessionId: sessionId(session),
    options: {
      getConfig: () => config,
      repository,
      adapter,
      getNickname: () => adapter.nickname,
      personaRoot,
    },
    contextWindow: createAnchoredContextWindow(),
    now: () => baseTime,
    wait: async () => {},
    random: () => 0.5,
    modelCall,
    rateLimiter: createRateLimiter(() => baseTime),
    trace: [],
    state: {
      config,
      settings: resolveSession(config, session),
      sentMessageIds: [],
      promptTemplates: promptTemplateStore.get(),
      promptFingerprints: [],
    },
  } as StepContext;
}

test('private context injects up to three fresh, member-visible group events with keyword priority', async () => {
  await withRepository(async (repository, personaRoot) => {
    await loadMemberCaches(repository);
    addEvent(repository, { groupId: GROUP_A, anchor: 'a-1', title: '桌游聚会', summary: '今天群里约桌游', hoursAgo: 1 });
    addEvent(repository, { groupId: GROUP_A, anchor: 'a-2', title: '今晚电影', summary: '电影院见面时间确认', hoursAgo: 2 });
    addEvent(repository, { groupId: GROUP_A, anchor: 'a-3', title: '手游分享', summary: '新游戏上线了', hoursAgo: 3 });
    addEvent(repository, {
      groupId: GROUP_A,
      anchor: 'a-4',
      title: '漫展集合',
      summary: '周末漫展集合时间已定 Bearer abcdefghijk',
      hoursAgo: 10,
    });
    addEvent(repository, { groupId: GROUP_A, anchor: 'a-old', title: '过期漫展', summary: '漫展上月取消', hoursAgo: 50 });
    addEvent(repository, { groupId: GROUP_B, anchor: 'b-1', title: '群外秘密', summary: '不应注入给群外成员', hoursAgo: 0.5 });

    const memberContext = makeContext(repository, personaRoot, MEMBER_A, '刚才说的漫展，集合时间是什么？');
    assert.deepEqual(await contextStep(memberContext), { next: true });
    const memberSystem = String(memberContext.state.prompt?.[0]?.content);
    const memberPrompt = String(memberContext.state.prompt?.[1]?.content);
    assert.ok(memberSystem.includes('群事件摘要'));
    assert.ok(memberPrompt.includes('漫展集合'));
    assert.ok(!memberPrompt.includes('手游分享'));
    assert.ok(!memberPrompt.includes('过期漫展'));
    assert.ok(!memberPrompt.includes('群外秘密'));
    assert.equal((memberPrompt.match(/"title":/gu) ?? []).length, 3);
    assert.ok(memberPrompt.includes('[敏感内容已隐藏]'));
    assert.ok(!memberPrompt.includes('Bearer abcdefghijk'));

    const outsiderContext = makeContext(repository, personaRoot, 99, '刚才说的漫展，集合时间是什么？');
    assert.deepEqual(await contextStep(outsiderContext), { next: true });
    const outsiderPrompt = String(outsiderContext.state.prompt?.[1]?.content);
    assert.ok(!outsiderPrompt.includes('漫展集合'));
    assert.ok(!outsiderPrompt.includes('群外秘密'));
  });
});
