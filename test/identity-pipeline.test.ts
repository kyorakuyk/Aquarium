import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionId } from '../src/core/shared/events.ts';
import { baseTime, createHarness, groupSession, makeConfig, makeIncoming, withRepository } from './pipeline-test-helpers.ts';

const groupId = sessionId(groupSession);

test('手动标记为 bot 的 @消息仍入库，但 gate 以 from_bot 跳过', async () => {
  await withRepository(async (repository, personaRoot) => {
    repository.setAccountKind(groupSession.account, 42, 'bot', baseTime);
    const harness = createHarness(repository, makeConfig(), personaRoot);
    const result = await harness.pipeline(makeIncoming({
      messageId: 'bot-mention',
      senderId: 42,
      mentionsSelf: true,
      plainText: '小鱼，帮忙回答',
    }));

    const stored = repository.messageBySessionAndId(groupId, 'bot-mention');
    assert.deepEqual(result, { replied: false, reason: 'from_bot' });
    assert.equal(harness.modelRequests.length, 0);
    assert.equal(harness.adapter.sent.length, 0);
    assert.deepEqual(stored && { senderId: stored.senderId, senderName: stored.senderName }, {
      senderId: 42,
      senderName: '小明',
    });
    assert.equal(repository.recentDecisions(1)[0]?.reason, 'from_bot');
  });
});

test('链接小号只在提示上下文中映射为主号，消息原样保存在原 sender_id 下', async () => {
  await withRepository(async (repository, personaRoot) => {
    repository.saveMessage({
      sessionId: groupId,
      messageId: 'main-before-link',
      senderId: 41,
      senderName: '主号昵称',
      isSelf: false,
      plainText: '旧消息',
      segments: [{ type: 'text', text: '旧消息' }],
      time: baseTime - 120_000,
    });
    repository.linkAltAccount({
      account: groupSession.account,
      aUserId: 41,
      bUserId: 43,
      createdAt: baseTime,
    });
    const harness = createHarness(repository, makeConfig(), personaRoot);
    const result = await harness.pipeline(makeIncoming({
      messageId: 'alt-message',
      senderId: 43,
      mentionsSelf: true,
      plainText: '小鱼，问候',
    }));

    const stored = repository.messageBySessionAndId(groupId, 'alt-message');
    assert.equal(result.reason, 'replied');
    const prompt = String(harness.modelRequests[0]?.messages[1]?.content);
    assert.match(prompt, /\[09:05\] "主号昵称": 小鱼，问候/u);
    assert.doesNotMatch(prompt, /\[09:05\] "小明": 小鱼，问候/u);
    assert.deepEqual(stored && { senderId: stored.senderId, senderName: stored.senderName }, {
      senderId: 43,
      senderName: '小明',
    });
  });
});
