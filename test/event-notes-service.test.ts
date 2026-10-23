import assert from 'node:assert/strict';
import test from 'node:test';
import type { QqProfileActions } from '../src/adapters/types.ts';
import { createPrivateFactsService } from '../src/core/privacy/service.ts';
import { createQqProfileService } from '../src/core/profiles/qq-profile-service.ts';
import { promptTemplateStore } from '../src/core/prompt/templates.ts';
import { sessionId, type SessionKey } from '../src/core/shared/events.ts';
import { FakeAdapter, baseTime, groupSession, makeConfig, withRepository } from './pipeline-test-helpers.ts';

const account = groupSession.account;
const ownerId = 42;
const groupId = groupSession.peer;
const privateSession: SessionKey = { account, kind: 'private', peer: ownerId };
const privateSessionId = sessionId(privateSession);

async function cacheGroupMember(repository: Parameters<Parameters<typeof withRepository>[0]>[0]): Promise<void> {
  const adapter = new FakeAdapter();
  Object.defineProperty(adapter, 'getGroupMembers', {
    value: async () => [{ userId: ownerId, nickname: '小明' }],
  });
  await createQqProfileService({ repository, now: () => baseTime }).readGroup({
    account,
    groupId,
    adapter: adapter as QqProfileActions,
  });
}

test('private extraction attaches an explicitly authorized explanation to its member-visible event', async () => {
  await withRepository(async (repository) => {
    await cacheGroupMember(repository);
    const eventTime = baseTime - 60_000;
    const eventId = repository.upsertGroupEvent({
      account,
      sourceGroupId: groupId,
      anchorMessageId: 'group-event-message',
      title: '周末漫展',
      summary: '群友约好周末一起逛漫展',
      participantIds: [ownerId],
      evidenceMessageIds: ['group-event-message'],
      occurredAt: eventTime,
      createdAt: eventTime,
      updatedAt: eventTime,
    });
    repository.saveMessage({
      sessionId: privateSessionId,
      messageId: 'private-explanation',
      senderId: ownerId,
      senderName: '小明',
      isSelf: false,
      plainText: '那次周末漫展其实是误会，我已经跟大家解释过。',
      segments: [],
      time: baseTime,
    });

    let promptText = '';
    const service = createPrivateFactsService({
      repository,
      getConfig: makeConfig,
      callModel: async (_slot, messages) => {
        promptText = String(messages[1]?.content);
        return {
          text: JSON.stringify({
            new: [],
            update: [],
            obsolete: [],
            eventNotes: [{
              eventId,
              text: '这次安排是误会 Bearer abcdefghijk',
              intent: 'clarify',
              messageIds: ['private-explanation'],
            }],
          }),
          provider: 'fake',
          model: 'fake-extract',
          usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
        };
      },
    });

    const result = await service.extractWindowUnderSessionLock({
      session: privateSession,
      records: repository.recentMessages(privateSessionId, 60),
      now: baseTime,
      template: promptTemplateStore.get().extractPrivate,
    });

    assert.equal(result.status, 'done');
    assert.ok(promptText.includes('周末漫展'));
    assert.ok(promptText.includes(String(eventId)));
    const notes = repository.listGroupEventNotesForOwner(account, ownerId);
    assert.equal(notes.length, 1);
    assert.equal(notes[0]?.eventId, eventId);
    assert.equal(notes[0]?.sourceSessionId, privateSessionId);
    assert.equal(notes[0]?.intent, 'clarify');
    assert.equal(notes[0]?.level, 'L1');
    assert.equal(notes[0]?.status, 'active');
    assert.deepEqual(notes[0]?.sourceMessageIds, ['private-explanation']);
    assert.ok(notes[0]?.text.includes('[敏感内容已隐藏]'));
    assert.ok(!notes[0]?.text.includes('Bearer abcdefghijk'));
  });
});

test('explicit private revocation retracts the owner’s event notes before night extraction', async () => {
  await withRepository(async (repository) => {
    const eventTime = baseTime - 60_000;
    const eventId = repository.upsertGroupEvent({
      account,
      sourceGroupId: groupId,
      anchorMessageId: 'revoke-event',
      title: '群内安排',
      summary: '大家约好周末集合',
      participantIds: [ownerId],
      evidenceMessageIds: ['revoke-event'],
      occurredAt: eventTime,
      createdAt: eventTime,
      updatedAt: eventTime,
    });
    const noteId = repository.upsertGroupEventNote({
      account,
      eventId,
      ownerId,
      sourceSessionId: privateSessionId,
      text: '集合时间曾经沟通有误',
      intent: 'clarify',
      level: 'L1',
      status: 'active',
      sourceMessageIds: ['private-explanation'],
      createdAt: baseTime - 30_000,
      updatedAt: baseTime - 30_000,
    });
    repository.saveMessage({
      sessionId: privateSessionId,
      messageId: 'private-revoke',
      senderId: ownerId,
      senderName: '小明',
      isSelf: false,
      plainText: '这件事别说出去。',
      segments: [],
      time: baseTime,
    });
    const service = createPrivateFactsService({ repository, getConfig: makeConfig });
    const revoke = Reflect.get(service, 'revokeEventNotesIfRequested');

    assert.equal(typeof revoke, 'function');
    assert.equal(revoke({
      session: privateSession,
      messageId: 'private-revoke',
      senderId: ownerId,
      now: baseTime,
    }), 1);
    const note = repository.listGroupEventNotesForOwner(account, ownerId).find(({ id }) => id === noteId);
    assert.equal(note?.intent, 'confide');
    assert.equal(note?.level, 'L0');
    assert.equal(note?.status, 'retracted');
    assert.ok(note?.updatedAt > baseTime);
  });
});

test('event-specific revocation leaves another active note from the same owner untouched', async () => {
  await withRepository(async (repository) => {
    const eventTime = baseTime - 60_000;
    const firstEventId = repository.upsertGroupEvent({
      account,
      sourceGroupId: groupId,
      anchorMessageId: 'mall-event',
      title: '周末漫展',
      summary: '周末漫展集合时间有调整',
      participantIds: [ownerId],
      evidenceMessageIds: ['mall-event'],
      occurredAt: eventTime,
      createdAt: eventTime,
      updatedAt: eventTime,
    });
    const secondEventId = repository.upsertGroupEvent({
      account,
      sourceGroupId: groupId,
      anchorMessageId: 'poll-event',
      title: '入群投票',
      summary: '报名方式改成两人一组',
      participantIds: [ownerId],
      evidenceMessageIds: ['poll-event'],
      occurredAt: eventTime + 1,
      createdAt: eventTime + 1,
      updatedAt: eventTime + 1,
    });
    const mallNoteId = repository.upsertGroupEventNote({
      account,
      eventId: firstEventId,
      ownerId,
      sourceSessionId: privateSessionId,
      text: '集合时间沟通有误',
      intent: 'clarify',
      level: 'L1',
      status: 'active',
      sourceMessageIds: ['private-mall-explanation'],
      createdAt: baseTime - 50_000,
      updatedAt: baseTime - 50_000,
    });
    const pollNoteId = repository.upsertGroupEventNote({
      account,
      eventId: secondEventId,
      ownerId,
      sourceSessionId: privateSessionId,
      text: '入群投票报名方式调整',
      intent: 'clarify',
      level: 'L1',
      status: 'active',
      sourceMessageIds: ['private-poll-explanation'],
      createdAt: baseTime - 40_000,
      updatedAt: baseTime - 40_000,
    });
    repository.saveMessage({
      sessionId: privateSessionId,
      messageId: 'private-mall-explanation',
      senderId: ownerId,
      senderName: '小明',
      isSelf: false,
      plainText: '周末漫展集合时间有调整，我已经跟大家解释过。',
      segments: [],
      time: baseTime - 3_000,
    });
    repository.saveMessage({
      sessionId: privateSessionId,
      messageId: 'private-poll-explanation',
      senderId: ownerId,
      senderName: '小明',
      isSelf: false,
      plainText: '入群投票报名方式改成两人一组。',
      segments: [],
      time: baseTime - 2_000,
    });
    repository.saveMessage({
      sessionId: privateSessionId,
      messageId: 'private-mall-revoke',
      senderId: ownerId,
      senderName: '小明',
      isSelf: false,
      plainText: '漫展这件事别说出去。',
      segments: [],
      time: baseTime,
    });
    const service = createPrivateFactsService({ repository, getConfig: makeConfig });
    const revoke = Reflect.get(service, 'revokeEventNotesIfRequested');

    assert.equal(revoke({
      session: privateSession,
      messageId: 'private-mall-revoke',
      senderId: ownerId,
      now: baseTime,
    }), 1);
    const notes = repository.listGroupEventNotesForOwner(account, ownerId);
    assert.equal(notes.find(({ id }) => id === mallNoteId)?.status, 'retracted');
    assert.equal(notes.find(({ id }) => id === pollNoteId)?.status, 'active');
  });
});
