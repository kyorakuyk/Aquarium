import assert from 'node:assert/strict';
import test from 'node:test';
import { createImpressionsService } from '../src/core/impressions/service.ts';
import { promptTemplateStore } from '../src/core/prompt/templates.ts';
import { sessionId } from '../src/core/shared/events.ts';
import { groupSession, makeConfig, withDefaultExtractProfiles, withRepository } from './pipeline-test-helpers.ts';

const account = groupSession.account;
const mainUserId = 42;
const altUserId = 43;
const now = Date.UTC(2026, 9, 21, 12);
const groupId = sessionId(groupSession);

test('小号历史提取在模型上下文和成员标签归属中都映射为主号', async () => {
  await withRepository(async (repository) => {
    repository.saveMessage({
      sessionId: groupId,
      messageId: 'main-name',
      senderId: mainUserId,
      senderName: '主号昵称',
      isSelf: false,
      plainText: '主号曾经发言',
      segments: [{ type: 'text', text: '主号曾经发言' }],
      time: now - 60_000,
    });
    repository.linkAltAccount({ account, aUserId: mainUserId, bUserId: altUserId, createdAt: now });
    const requests: string[] = [];
    const service = createImpressionsService({
      repository,
      getConfig: () => makeConfig({ nicknames: [] }),
      now: () => now,
      callModel: async (_slot, messages) => {
        requests.push(messages.map((message) => String(message.content)).join('\n'));
        return {
          text: withDefaultExtractProfiles(JSON.stringify({
            group: { observe: [], new: [], contradict: [] },
            members: [{
              userId: mainUserId,
              observe: [],
              new: [{ text: '乐于助人', messageId: 'alt-evidence' }],
              contradict: [],
            }],
          })),
          provider: 'fake',
          model: 'fake-model',
          usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
        };
      },
    });
    const release = service.tryAcquireSession(groupId);
    assert.ok(release);
    try {
      const summary = await service.extractWindowUnderSessionLock({
        session: groupSession,
        records: [{
          sessionId: groupId,
          messageId: 'alt-evidence',
          senderId: altUserId,
          senderName: '小号昵称',
          isSelf: false,
          plainText: '我经常主动帮助群友',
          segments: [{ type: 'text', text: '我经常主动帮助群友' }],
          time: now,
        }],
        now,
        template: promptTemplateStore.get().extractTags,
      });
      assert.equal(summary.status, 'done');
    } finally {
      release();
    }

    assert.match(requests[0] ?? '', /"主号昵称"\(QQ 42\): 我经常主动帮助群友 #alt-evidence/u);
    assert.doesNotMatch(requests[0] ?? '', /"小号昵称"\(QQ 43\)/u);
    assert.equal(repository.listTagsForSubject(account, groupId, mainUserId).some((tag) => tag.text === '乐于助人'), true);
    assert.equal(repository.listTagsForSubject(account, groupId, altUserId).length, 0);
  });
});
