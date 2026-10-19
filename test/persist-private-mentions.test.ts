import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionId } from '../src/core/events.ts';
import { createMessagePipeline } from '../src/core/pipeline.ts';
import { promptTemplateStore } from '../src/core/prompt-templates.ts';
import type { PrivateMentionService } from '../src/core/privacy/mentions.ts';
import { baseTime, FakeAdapter, groupSession, makeConfig, makeIncoming, withRepository } from './pipeline-test-helpers.ts';

test('persist schedules owner-mention assessment after insert but skips duplicates and replay', async () => {
  await withRepository(async (repository, personaRoot) => {
    const calls: Array<{ messageId: string; templateVersion: string }> = [];
    const privateMentionService: PrivateMentionService = {
      maybePromote(input) {
        assert.ok(repository.messageBySessionAndId(sessionId(input.session), input.messageId));
        calls.push({ messageId: input.messageId, templateVersion: input.template.version });
      },
      async idle() {},
    };
    const adapter = new FakeAdapter();
    const pipeline = createMessagePipeline({
      getConfig: makeConfig,
      repository,
      adapter,
      getNickname: () => adapter.nickname,
      personaRoot,
      privateMentionService,
      callModel: async () => ({
        text: '收到。',
        provider: 'fake',
        model: 'fake-reply',
        usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
      }),
      now: () => baseTime,
      wait: async () => {},
    });
    const incoming = makeIncoming({
      messageId: 'mention-persist',
      plainText: '小鱼，考研这件事我最近会提到。',
      mentionsSelf: true,
      senderId: 42,
      time: baseTime,
    });

    await pipeline(incoming);
    await pipeline(incoming);
    await pipeline(incoming, { replay: true });

    assert.deepEqual(calls, [{
      messageId: incoming.messageId,
      templateVersion: promptTemplateStore.get().privacyMention.version,
    }]);
  });
});
