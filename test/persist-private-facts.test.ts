import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionId, type SessionKey } from '../src/core/shared/events.ts';
import { createMessagePipeline } from '../src/core/conversation/pipeline.ts';
import { promptTemplateStore } from '../src/core/prompt/templates.ts';
import { baseTime, FakeAdapter, groupSession, makeConfig, makeIncoming, withRepository } from './pipeline-test-helpers.ts';

const privateSession: SessionKey = { account: groupSession.account, kind: 'private', peer: 42 };

test('persist schedules private extraction only after an incoming peer message is stored', async () => {
  await withRepository(async (repository, personaRoot) => {
    const calls: Array<{ messageId: string; templateVersion: string }> = [];
    const privateFactsService = {
      promptBlock() { return undefined; },
      revokeEventNotesIfRequested() { return 0; },
      maybeExtract(input: { messageId: string; template: { version: string } }) {
        assert.ok(repository.messageBySessionAndId(sessionId(privateSession), input.messageId));
        calls.push({ messageId: input.messageId, templateVersion: input.template.version });
      },
      async idle() {},
    };
    const options = {
      getConfig: () => makeConfig(),
      repository,
      adapter: new FakeAdapter(),
      getNickname: () => 'Aquarium',
      now: () => baseTime,
      personaRoot,
      privateFactsService,
    } as Parameters<typeof createMessagePipeline>[0] & { privateFactsService: typeof privateFactsService };
    const pipeline = createMessagePipeline(options);

    await pipeline(makeIncoming({
      messageId: 'private-incoming',
      session: privateSession,
      senderId: privateSession.peer,
      plainText: '最近开始准备考试',
      time: baseTime,
    }));
    await pipeline(makeIncoming({
      messageId: 'private-replay',
      session: privateSession,
      senderId: privateSession.peer,
      plainText: '不应触发重放抽取',
      time: baseTime + 1,
    }), { replay: true });
    await pipeline(makeIncoming({
      messageId: 'private-unrelated-sender',
      session: privateSession,
      senderId: 43,
      plainText: '不属于该私聊对象',
      time: baseTime + 2,
    }));

    assert.deepEqual(calls, [{
      messageId: 'private-incoming',
      templateVersion: promptTemplateStore.get().extractPrivate.version,
    }]);
  });
});

test('persist checks immediate event-note revocations while daytime private messages only write memos', async () => {
  await withRepository(async (repository, personaRoot) => {
    const revocations: string[] = [];
    const memos: string[] = [];
    const privateFactsService = {
      promptBlock() { return undefined; },
      maybeExtract() { throw new Error('daytime should not extract private facts'); },
      revokeEventNotesIfRequested(input: { messageId: string }) {
        assert.ok(repository.messageBySessionAndId(sessionId(privateSession), input.messageId));
        revocations.push(input.messageId);
      },
      async idle() {},
    };
    const personaMemoryService = {
      observeMessage(message: { messageId: string }) { memos.push(message.messageId); },
      recentDiaryBlock() { return undefined; },
    };
    const adapter = new FakeAdapter();
    const pipeline = createMessagePipeline({
      getConfig: () => makeConfig(),
      repository,
      adapter,
      getNickname: () => 'Aquarium',
      now: () => baseTime,
      personaRoot,
      privateFactsService,
      personaMemoryService,
      callModel: async () => ({
        text: '收到。',
        provider: 'fake',
        model: 'fake-model',
        usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
      }),
    } as Parameters<typeof createMessagePipeline>[0]);

    await pipeline(makeIncoming({
      messageId: 'private-revocation',
      session: privateSession,
      senderId: privateSession.peer,
      plainText: '这件事别说出去。',
      time: baseTime,
    }));

    assert.deepEqual(revocations, ['private-revocation']);
    assert.deepEqual(memos, ['private-revocation']);
  });
});
