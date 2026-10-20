import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionId } from '../src/core/shared/events.ts';
import { promptTemplateStore } from '../src/core/prompt/templates.ts';
import { createPrivacyMentionService } from '../src/core/privacy/mentions.ts';
import type { PrivateFactRecord } from '../src/store/privacy-repo.ts';
import { baseTime, groupSession, makeConfig, withRepository } from './pipeline-test-helpers.ts';

function fact(ownerId: number, text: string, keywords: string[], level: 'L0' | 'L1' | 'L2' = 'L0'):
Omit<PrivateFactRecord, 'id'> {
  return {
    account: groupSession.account,
    ownerId,
    sessionId: `${groupSession.account}:private:${ownerId}`,
    text,
    keywords,
    level,
    levelSource: 'auto',
    mentions: 0,
    mentionEvidence: [],
    evidence: [],
    status: 'active',
    createdAt: baseTime,
    updatedAt: baseTime,
  };
}

function saveGroupMessage(
  repository: Parameters<Parameters<typeof withRepository>[0]>[0],
  messageId: string,
  senderId: number,
  plainText: string,
  time = baseTime,
): void {
  repository.saveMessage({
    sessionId: sessionId(groupSession),
    messageId,
    senderId,
    senderName: `user-${senderId}`,
    isSelf: false,
    plainText,
    segments: [],
    time,
  });
}

function modelResult(text: string) {
  return {
    text,
    provider: 'fake',
    model: 'fake-judge',
    usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
  };
}

test('owner-only keyword matches call the mention judge and count once per day', async () => {
  await withRepository(async (repository) => {
    const ownerFactId = repository.insertPrivateFact(fact(42, '最近在准备考研，压力较大', ['考研', '压力']));
    repository.insertPrivateFact(fact(43, '喜欢周末爬山', ['周末', '爬山']));
    repository.insertPrivateFact(fact(42, '喜欢爵士钢琴', ['爵士', '钢琴']));
    const messageId = 'owner-mentioned-fact';
    const groupKey = sessionId(groupSession);
    const messageText = '我最近确实在准备考研，感觉压力很大';
    saveGroupMessage(repository, messageId, 42, messageText);
    let calls = 0;
    let debugTraceProvided = false;
    const summaries: Array<{ factId: number; mentions: number; level: string }> = [];
    const service = createPrivacyMentionService({
      repository,
      getConfig: makeConfig,
      now: () => baseTime + 10,
      callModel: async (_slot, messages, options) => {
        calls += 1;
        debugTraceProvided = options.debugTrace !== undefined;
        const promptText = String(messages[1]?.content);
        assert.ok(promptText.includes(`#${ownerFactId} 最近在准备考研，压力较大`));
        assert.equal(promptText.includes('喜欢周末爬山'), false);
        assert.equal(promptText.includes('喜欢爵士钢琴'), false);
        return modelResult(JSON.stringify({ mentions: [ownerFactId] }));
      },
      onMention: (summary) => summaries.push(summary),
    });

    service.maybePromote({
      session: groupSession,
      senderId: 42,
      messageId,
      now: baseTime,
      template: promptTemplateStore.get().privacyMention,
    });
    await service.idle();
    const repeatedId = 'owner-second-same-day';
    saveGroupMessage(repository, repeatedId, 42, messageText, baseTime + 60_000);
    service.maybePromote({
      session: groupSession,
      senderId: 42,
      messageId: repeatedId,
      now: baseTime + 60_000,
      template: promptTemplateStore.get().privacyMention,
    });
    await service.idle();

    const updated = repository.privateFactById(ownerFactId);
    assert.equal(calls, 1);
    assert.equal(debugTraceProvided, false);
    assert.equal(updated?.mentions, 1);
    assert.equal(updated?.level, 'L1');
    assert.deepEqual(updated?.mentionEvidence, [{ sessionId: groupKey, messageId, time: baseTime }]);
    assert.deepEqual(summaries, [{
      account: groupSession.account,
      sessionId: groupKey,
      factId: ownerFactId,
      mentions: 1,
      level: 'L1',
    }]);
  });
});

test('non-owner messages and keyword misses do not call the mention judge', async () => {
  await withRepository(async (repository) => {
    repository.insertPrivateFact(fact(42, '最近在准备考研，压力较大', ['考研', '压力']));
    saveGroupMessage(repository, 'other-speaker', 43, '我也在准备考研');
    saveGroupMessage(repository, 'owner-no-keyword', 42, '今晚一起玩游戏吗？');
    let calls = 0;
    const service = createPrivacyMentionService({
      repository,
      getConfig: makeConfig,
      callModel: async () => {
        calls += 1;
        return modelResult('{"mentions":[]}');
      },
    });

    service.maybePromote({
      session: groupSession,
      senderId: 43,
      messageId: 'other-speaker',
      now: baseTime,
      template: promptTemplateStore.get().privacyMention,
    });
    service.maybePromote({
      session: groupSession,
      senderId: 42,
      messageId: 'owner-no-keyword',
      now: baseTime,
      template: promptTemplateStore.get().privacyMention,
    });
    await service.idle();

    assert.equal(calls, 0);
    assert.equal(repository.listPrivateFactsForOwner(groupSession.account, 42)[0]?.mentions, 0);
  });
});

test('parse failure is conservative and a later owner mention is recorded', async () => {
  await withRepository(async (repository) => {
    const id = repository.insertPrivateFact(fact(42, '最近在准备考研，压力较大', ['考研', '压力']));
    const firstMessage = 'owner-first-mention';
    const secondMessage = 'owner-second-mention';
    const text = '我最近在准备考研，感觉压力很大';
    saveGroupMessage(repository, firstMessage, 42, text, baseTime);
    saveGroupMessage(repository, secondMessage, 42, text, baseTime + 60_000);
    let calls = 0;
    const service = createPrivacyMentionService({
      repository,
      getConfig: makeConfig,
      now: () => baseTime + 10,
      callModel: async () => {
        calls += 1;
        return modelResult(calls === 1 ? 'not json' : JSON.stringify({ mentions: [id] }));
      },
    });

    service.maybePromote({
      session: groupSession,
      senderId: 42,
      messageId: firstMessage,
      now: baseTime,
      template: promptTemplateStore.get().privacyMention,
    });
    await service.idle();
    assert.equal(repository.privateFactById(id)?.mentions, 0);

    service.maybePromote({
      session: groupSession,
      senderId: 42,
      messageId: secondMessage,
      now: baseTime + 60_000,
      template: promptTemplateStore.get().privacyMention,
    });
    await service.idle();

    assert.equal(calls, 2);
    assert.equal(repository.privateFactById(id)?.mentions, 1);
    assert.equal(repository.privateFactById(id)?.level, 'L1');
  });
});
