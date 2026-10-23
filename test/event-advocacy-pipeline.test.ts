import assert from 'node:assert/strict';
import test from 'node:test';
import { createMessagePipeline } from '../src/core/conversation/pipeline.ts';
import { deliverStep } from '../src/core/conversation/steps/deliver.ts';
import { persistStep } from '../src/core/conversation/steps/persist.ts';
import type { StepContext } from '../src/core/conversation/steps/types.ts';
import { createAnchoredContextWindow } from '../src/core/conversation/context-window.ts';
import { createRateLimiter } from '../src/core/shared/rate-limit.ts';
import { sessionId } from '../src/core/shared/events.ts';
import { promptTemplateStore } from '../src/core/prompt/templates.ts';
import { baseTime, FakeAdapter, groupSession, makeConfig, makeIncoming, withRepository } from './pipeline-test-helpers.ts';

test('deliver marks an advocacy confirmation only after the private question is sent', async () => {
  await withRepository(async (repository) => {
    const ownerId = 42;
    const privateSession = { account: groupSession.account, kind: 'private' as const, peer: ownerId };
    const privateSessionId = sessionId(privateSession);
    const eventId = repository.upsertGroupEvent({
      account: groupSession.account,
      sourceGroupId: groupSession.peer,
      anchorMessageId: 'delivery-event',
      title: '漫展集合',
      summary: '群友约好周末参加漫展',
      participantIds: [ownerId],
      evidenceMessageIds: ['delivery-event'],
      occurredAt: baseTime - 60_000,
      createdAt: baseTime - 60_000,
      updatedAt: baseTime - 60_000,
    });
    repository.upsertGroupEventNote({
      account: groupSession.account,
      eventId,
      ownerId,
      sourceSessionId: privateSessionId,
      text: '集合时间改为周日下午三点',
      intent: 'advocate',
      level: 'L2',
      status: 'active',
      sourceMessageIds: ['private-request'],
      createdAt: baseTime - 30_000,
      updatedAt: baseTime - 30_000,
    });
    repository.ensureEventAdvocacyPending({
      account: groupSession.account,
      eventId,
      ownerId,
      sourceSessionId: privateSessionId,
      requestedAt: baseTime - 30_000,
    });
    const adapter = new FakeAdapter();
    const config = makeConfig({ nicknames: [] });
    const replyText = '那我去群里说一下「漫展集合」的事，可以吗？';
    const context = {
      message: makeIncoming({
        session: privateSession,
        senderId: ownerId,
        messageId: 'private-request',
        plainText: '你能帮我在群里说一下吗？',
        time: baseTime,
      }),
      processOptions: { quoteReplyTo: false },
      currentSessionId: privateSessionId,
      options: {
        getConfig: () => config,
        repository,
        adapter,
        getNickname: () => adapter.nickname,
      },
      contextWindow: createAnchoredContextWindow(),
      now: () => baseTime,
      wait: async () => {},
      random: () => 0.5,
      modelCall: async () => { throw new Error('not called'); },
      rateLimiter: createRateLimiter(() => baseTime),
      trace: [],
      state: {
        nickname: adapter.nickname,
        result: {
          text: replyText,
          provider: 'fake',
          model: 'fake',
          usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, costCny: 0 },
        },
        replyText,
        sentMessageIds: [],
        eventAdvocacyPromptEventId: eventId,
        promptTemplates: promptTemplateStore.get(),
        promptFingerprints: [],
      },
    } as unknown as StepContext;

    assert.equal((await deliverStep(context)).reason, 'replied');
    const advocacy = repository.eventAdvocacyByEvent(groupSession.account, eventId);
    assert.equal(advocacy?.promptMessageId, 'out-1');
    assert.equal(advocacy?.promptedAt, baseTime);
  });
});

test('persist confirms only an explicit answer to a delivered advocacy prompt', async () => {
  await withRepository(async (repository) => {
    const ownerId = 42;
    const privateSession = { account: groupSession.account, kind: 'private' as const, peer: ownerId };
    const privateSessionId = sessionId(privateSession);
    const eventId = repository.upsertGroupEvent({
      account: groupSession.account,
      sourceGroupId: groupSession.peer,
      anchorMessageId: 'persist-event',
      title: '漫展集合',
      summary: '群友约好周末参加漫展',
      participantIds: [ownerId],
      evidenceMessageIds: ['persist-event'],
      occurredAt: baseTime - 60_000,
      createdAt: baseTime - 60_000,
      updatedAt: baseTime - 60_000,
    });
    repository.upsertGroupEventNote({
      account: groupSession.account,
      eventId,
      ownerId,
      sourceSessionId: privateSessionId,
      text: '集合时间改为周日下午三点',
      intent: 'advocate',
      level: 'L2',
      status: 'active',
      sourceMessageIds: ['private-request'],
      createdAt: baseTime - 30_000,
      updatedAt: baseTime - 30_000,
    });
    repository.ensureEventAdvocacyPending({
      account: groupSession.account,
      eventId,
      ownerId,
      sourceSessionId: privateSessionId,
      requestedAt: baseTime - 30_000,
    });
    repository.saveMessage({
      sessionId: privateSessionId,
      messageId: 'private-prompt',
      senderId: groupSession.account,
      senderName: 'Aquarium',
      isSelf: true,
      plainText: '那我去群里说一下「漫展集合」的事，可以吗？',
      segments: [],
      time: baseTime - 1_000,
    });
    repository.markEventAdvocacyPrompted({
      account: groupSession.account,
      eventId,
      ownerId,
      promptMessageId: 'private-prompt',
      promptedAt: baseTime - 1_000,
    });
    const adapter = new FakeAdapter();
    const config = makeConfig();
    const confirmed: number[] = [];
    const context = {
      message: makeIncoming({
        session: privateSession,
        senderId: ownerId,
        messageId: 'private-yes',
        plainText: '可以',
        time: baseTime,
      }),
      processOptions: {},
      currentSessionId: privateSessionId,
      options: {
        getConfig: () => config,
        repository,
        adapter,
        getNickname: () => adapter.nickname,
        onEventAdvocacyConfirmed: (confirmedEventId: number) => confirmed.push(confirmedEventId),
      },
      contextWindow: createAnchoredContextWindow(),
      now: () => baseTime,
      wait: async () => {},
      random: () => 0.5,
      modelCall: async () => { throw new Error('not called'); },
      rateLimiter: createRateLimiter(() => baseTime),
      trace: [],
      state: { sentMessageIds: [], promptTemplates: promptTemplateStore.get(), promptFingerprints: [] },
    } as unknown as StepContext;

    assert.deepEqual(await persistStep(context), { next: true });
    assert.deepEqual(confirmed, [eventId]);
    assert.equal(repository.eventAdvocacyByEvent(groupSession.account, eventId)?.status, 'confirmed');
  });
});

test('message pipeline exposes the gated one-time advocacy sender', async () => {
  await withRepository(async (repository) => {
    const eventId = repository.upsertGroupEvent({
      account: groupSession.account,
      sourceGroupId: groupSession.peer,
      anchorMessageId: 'pipeline-event',
      title: '桌游聚会',
      summary: '群友约好周五玩桌游',
      participantIds: [42],
      evidenceMessageIds: ['pipeline-event'],
      occurredAt: baseTime - 60_000,
      createdAt: baseTime - 60_000,
      updatedAt: baseTime - 60_000,
    });
    repository.upsertGroupEventNote({
      account: groupSession.account,
      eventId,
      ownerId: 42,
      sourceSessionId: `${groupSession.account}:private:42`,
      text: '周五晚上七点开始',
      intent: 'advocate',
      level: 'L2',
      status: 'active',
      sourceMessageIds: ['pipeline-private-request'],
      createdAt: baseTime - 30_000,
      updatedAt: baseTime - 30_000,
    });
    repository.ensureEventAdvocacyPending({
      account: groupSession.account,
      eventId,
      ownerId: 42,
      sourceSessionId: `${groupSession.account}:private:42`,
      requestedAt: baseTime - 30_000,
    });
    repository.markEventAdvocacyPrompted({
      account: groupSession.account,
      eventId,
      ownerId: 42,
      promptMessageId: 'pipeline-prompt',
      promptedAt: baseTime - 20_000,
    });
    repository.confirmEventAdvocacy({
      account: groupSession.account,
      eventId,
      ownerId: 42,
      promptMessageId: 'pipeline-prompt',
      confirmationMessageId: 'pipeline-yes',
      confirmedAt: baseTime - 10_000,
    });
    const adapter = new FakeAdapter();
    const pipeline = createMessagePipeline({
      getConfig: () => makeConfig({ sessions: {
        [sessionId(groupSession)]: { enabled: true, mode: 'active' },
      } }),
      repository,
      adapter,
      getNickname: () => adapter.nickname,
      isOnline: () => true,
      now: () => baseTime,
    }) as unknown as { sendEventAdvocacy(eventId: number): Promise<string> };

    assert.equal(typeof pipeline.sendEventAdvocacy, 'function');
    assert.equal(await pipeline.sendEventAdvocacy(eventId), 'sent');
    assert.equal(adapter.sent.length, 1);
    assert.equal(repository.eventAdvocacyByEvent(groupSession.account, eventId)?.status, 'sent');
  });
});
