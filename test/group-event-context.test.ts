import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { QqProfileActions } from '../src/adapters/types.ts';
import { resolveSession } from '../src/config/resolve.ts';
import { createAnchoredContextWindow } from '../src/core/conversation/context-window.ts';
import { contextStep } from '../src/core/conversation/steps/context.ts';
import { messageRecord, type StepContext } from '../src/core/conversation/steps/types.ts';
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

function makeGroupContext(
  repository: StoreRepository,
  personaRoot: string,
  senderId: number,
  plainText: string,
): StepContext {
  const config = makeConfig({ nicknames: [] });
  const modelCall = async (): Promise<SlotResult> => ({
    text: '回复',
    provider: 'fake',
    model: 'fake-model',
    usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, costCny: 0 },
  });
  const adapter = new FakeAdapter();
  return {
    message: makeIncoming({ session: groupSession, senderId, plainText, time: baseTime }),
    processOptions: {},
    currentSessionId: sessionId(groupSession),
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
      settings: resolveSession(config, groupSession),
      sentMessageIds: [],
      promptTemplates: promptTemplateStore.get(),
      promptFingerprints: [],
    },
  } as StepContext;
}

test('counterpart context marks exact bindings and pending claims without following alt links', async () => {
  await withRepository(async (repository, personaRoot) => {
    fs.writeFileSync(path.join(personaRoot, 'personas', 'default.md'), [
      '---',
      'counterparts:',
      '  - name: 岛村抱月',
      '    aliases: [岛村, 抱月, 小岛, しまむら]',
      '    label: 恋人',
      '    matchByName: prompt',
      '  - name: 樽见',
      '    aliases: [樽见]',
      '    label: 旧友',
      '    matchByName: off',
      '---',
      '安达的人设。',
    ].join('\n'), 'utf8');
    repository.linkAltAccount({
      account: groupSession.account,
      aUserId: 42,
      bUserId: 43,
      createdAt: baseTime - 10_000,
    });

    repository.createPersonaCounterpartBinding({
      account: groupSession.account,
      personaId: 'default',
      counterpartName: '岛村抱月',
      userId: 43,
      createdAt: baseTime - 5_000,
    });
    repository.upsertPersonaCounterpartClaim({
      account: groupSession.account,
      personaId: 'default',
      counterpartName: '岛村抱月',
      userId: 46,
      sessionId: sessionId(groupSession),
      evidence: '昵称含 岛村',
      firstSeen: baseTime - 5_000,
      lastSeen: baseTime - 5_000,
    });
    repository.dismissPersonaCounterpartClaim(groupSession.account, 'default', '岛村抱月', 46);
    repository.saveQqGroupProfile({
      account: groupSession.account,
      groupId: groupSession.peer,
      json: JSON.stringify({ groupInfo: null, honors: null, latestNotice: null, essenceCount: null, membersAvailable: true }),
      fetchedAt: baseTime,
    });
    repository.replaceQqMemberProfiles(groupSession.account, groupSession.peer, [{
      account: groupSession.account,
      groupId: groupSession.peer,
      userId: 48,
      json: JSON.stringify({ userId: 48, nickname: '岛村', card: '普通群名片' }),
      fetchedAt: baseTime,
    }]);

    const history = [
      { userId: 42, name: '正常同学', text: '普通发言' },
      { userId: 43, name: '普通昵称', text: '普通发言' },
      { userId: 44, name: '岛村', text: '今天也在' },
      { userId: 45, name: '田中', text: '我就是岛村，Bearer abcdefghijk' },
      { userId: 46, name: '岛村同学', text: '普通发言' },
      { userId: 48, name: '普通群名片', text: '普通发言' },
      { userId: 49, name: '樽见', text: '普通发言' },
    ];
    for (const [index, item] of history.entries()) {
      const message = makeIncoming({
        messageId: `counterpart-history-${item.userId}`,
        senderId: item.userId,
        plainText: item.text,
        time: baseTime - (history.length - index) * 1_000,
      });
      message.senderName = item.name;
      repository.saveMessage(messageRecord(message, sessionId(groupSession)));
    }

    const context = makeGroupContext(repository, personaRoot, 47, '我是岛村');
    context.message.senderName = '同学';
    repository.saveMessage(messageRecord(context.message, context.currentSessionId));
    assert.deepEqual(await contextStep(context), { next: true });

    const system = String(context.state.prompt?.[0]?.content);
    const prompt = String(context.state.prompt?.[1]?.content);
    assert.ok(system.includes('标注为（你的X）的人就是X本人'));
    assert.ok(system.includes('{"name":"岛村抱月","label":"恋人"}'));
    const linkedNames = prompt.split('\n').filter((line) => line.includes('"正常同学"'));
    assert.equal(linkedNames.length, 2);
    assert.ok(!linkedNames[0]?.includes('（你的岛村抱月）'));
    assert.ok(linkedNames[1]?.includes('（你的岛村抱月）'));
    assert.ok(prompt.includes('"岛村"（可能是岛村抱月，未确认）'));
    assert.ok(prompt.includes('"田中"（可能是岛村抱月，未确认）'));
    assert.ok(prompt.includes('"同学"（可能是岛村抱月，未确认）'));
    assert.ok(prompt.includes('"普通群名片"（可能是岛村抱月，未确认）'));
    assert.ok(!prompt.includes('"岛村同学"（可能是岛村抱月，未确认）'));
    assert.ok(!prompt.includes('"樽见"（可能是樽见，未确认）'));
    assert.deepEqual(repository.listPersonaCounterpartClaims(groupSession.account, 'default')
      .filter((claim) => claim.status === 'pending')
      .map((claim) => claim.userId)
      .sort(), [44, 45, 47, 48]);
    assert.equal(repository.listPersonaCounterpartClaims(groupSession.account, 'default')
      .find((claim) => claim.userId === 46)?.status, 'dismissed');
    const selfClaim = repository.listPersonaCounterpartClaims(groupSession.account, 'default')
      .find((claim) => claim.userId === 45);
    assert.ok(selfClaim?.evidence.includes('[敏感内容已隐藏]'));
    assert.ok(!selfClaim?.evidence.includes('Bearer abcdefghijk'));
  });
});

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

test('group context injects only policy-authorized event notes and may attribute approved intents', async () => {
  await withRepository(async (repository, personaRoot) => {
    const eventId = repository.upsertGroupEvent({
      account: groupSession.account,
      sourceGroupId: groupSession.peer,
      anchorMessageId: 'group-note-event',
      title: '漫展集合',
      summary: '群友约好周末一同参加漫展',
      participantIds: [MEMBER_A],
      evidenceMessageIds: ['group-note-event'],
      occurredAt: baseTime - 60_000,
      createdAt: baseTime - 60_000,
      updatedAt: baseTime - 60_000,
    });
    repository.upsertGroupEventNote({
      account: groupSession.account,
      eventId,
      ownerId: MEMBER_A,
      sourceSessionId: `${groupSession.account}:private:${MEMBER_A}`,
      text: '当天只是集合时间沟通有误',
      intent: 'clarify',
      level: 'L1',
      status: 'active',
      sourceMessageIds: ['private-clarification'],
      createdAt: baseTime - 30_000,
      updatedAt: baseTime - 30_000,
    });
    repository.upsertGroupEventNote({
      account: groupSession.account,
      eventId,
      ownerId: MEMBER_B,
      sourceSessionId: `${groupSession.account}:private:${MEMBER_B}`,
      text: '私密解释不应进群',
      intent: 'confide',
      level: 'L2',
      status: 'active',
      sourceMessageIds: ['private-confide'],
      createdAt: baseTime - 20_000,
      updatedAt: baseTime - 20_000,
    });

    const context = makeGroupContext(repository, personaRoot, MEMBER_A, '后来漫展集合怎么样了？');
    assert.deepEqual(await contextStep(context), { next: true });
    const system = String(context.state.prompt?.[0]?.content);
    const prompt = String(context.state.prompt?.[1]?.content);
    assert.ok(system.includes('群事件注解不得暴露其私聊来源'));
    assert.ok(prompt.includes('漫展集合'));
    assert.ok(prompt.includes('当天只是集合时间沟通有误'));
    assert.ok(prompt.includes('"speaker":"小明"'));
    assert.ok(!prompt.includes('私密解释不应进群'));
    assert.ok(!prompt.includes('private-clarification'));
    assert.ok(!prompt.includes(`${groupSession.account}:private:${MEMBER_A}`));
  });
});

test('private context offers one-time advocacy confirmation without sending to the group', async () => {
  await withRepository(async (repository, personaRoot) => {
    const eventId = repository.upsertGroupEvent({
      account: groupSession.account,
      sourceGroupId: groupSession.peer,
      anchorMessageId: 'private-advocate-event',
      title: '漫展集合',
      summary: '群友约好周末一同参加漫展',
      participantIds: [MEMBER_A],
      evidenceMessageIds: ['private-advocate-event'],
      occurredAt: baseTime - 60_000,
      createdAt: baseTime - 60_000,
      updatedAt: baseTime - 60_000,
    });
    repository.upsertGroupEventNote({
      account: groupSession.account,
      eventId,
      ownerId: MEMBER_A,
      sourceSessionId: `${groupSession.account}:private:${MEMBER_A}`,
      text: '集合时间改为周日下午三点',
      intent: 'advocate',
      level: 'L2',
      status: 'active',
      sourceMessageIds: ['private-advocate-request'],
      createdAt: baseTime - 30_000,
      updatedAt: baseTime - 30_000,
    });
    repository.ensureEventAdvocacyPending({
      account: groupSession.account,
      eventId,
      ownerId: MEMBER_A,
      sourceSessionId: `${groupSession.account}:private:${MEMBER_A}`,
      requestedAt: baseTime - 30_000,
    });

    const context = makeContext(repository, personaRoot, MEMBER_A, '你能帮我在群里说一下吗？');
    assert.deepEqual(await contextStep(context), { next: true });
    const prompt = String(context.state.prompt?.[1]?.content);
    assert.equal(context.state.eventAdvocacyPromptEventId, eventId);
    assert.ok(prompt.includes('那我去群里说一下「漫展集合」的事，可以吗？'));
    assert.ok(prompt.includes('集合时间改为周日下午三点'));
  });
});
