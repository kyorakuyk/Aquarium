import assert from 'node:assert/strict';
import test from 'node:test';
import { promptTemplateStore } from '../src/core/prompt/templates.ts';
import { sessionId } from '../src/core/shared/events.ts';
import type { TagRecord } from '../src/store/affect-repo.ts';
import { account, authHeaders, groupSession, now, withPanel } from './panel-test-helpers.ts';

function tag(session: string, userId: number | null, text: string, category: TagRecord['category']): TagRecord {
  return {
    account,
    sessionId: session,
    userId,
    text,
    norm: text,
    category,
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
  };
}

test('impressions detail exposes actual group injection and local speaker activity across linked alts', async () => {
  await withPanel(async ({ app, repository }) => {
    const groupId = sessionId(groupSession);
    repository.insertTag(tag(groupId, null, '游戏', 'positioning'));
    repository.insertTag(tag(groupId, 43, '喜欢摄影', 'personality'));
    repository.createRelation({
      account,
      aUserId: 42,
      bUserId: 45,
      type: 'alt',
      label: null,
      locked: false,
      createdAt: now,
    });
    for (const message of [
      { messageId: 'speaker-1', senderId: 42, time: now - 300, isSelf: false },
      { messageId: 'alt-speaker', senderId: 45, time: now - 200, isSelf: false },
      { messageId: 'speaker-2', senderId: 42, time: now - 100, isSelf: false },
      { messageId: 'self-message', senderId: account, time: now, isSelf: true },
    ]) {
      repository.saveMessage({
        sessionId: groupId,
        ...message,
        senderName: `成员${message.senderId}`,
        plainText: '测试消息',
        segments: [],
      });
    }
    repository.recordTagDrop({
      account,
      sessionId: groupId,
      userId: null,
      category: 'personality',
      text: '常深夜打游戏',
      reason: 'schedule_by_stats',
      time: now - 100,
    });
    repository.recordTagDrop({
      account,
      sessionId: groupId,
      userId: 42,
      category: 'personality',
      text: '常深夜玩游戏',
      reason: 'schedule_by_stats',
      time: now,
    });

    const response = await app.request(`/api/impressions/${encodeURIComponent(groupId)}`, { headers: authHeaders() });
    assert.equal(response.status, 200);
    const view = await response.json() as {
      groupTagsText: string | null;
      groupScheduleDrop: { text: string } | null;
      members: Array<{
        userId: number;
        messageCount: number;
        lastMessageTime: number | null;
        scheduleDrop: { text: string } | null;
      }>;
    };
    assert.equal(view.groupTagsText, promptTemplateStore.get().replySystem.groupTags.replaceAll('{{tags}}', '游戏'));
    assert.equal(view.groupScheduleDrop?.text, '常深夜打游戏');
    const speaker = view.members.find((member) => member.userId === 42);
    assert.equal(speaker?.messageCount, 3);
    assert.equal(speaker?.lastMessageTime, now - 100);
    assert.equal(speaker?.scheduleDrop?.text, '常深夜玩游戏');
    assert.equal(view.members.find((member) => member.userId === 43)?.messageCount, 0);
    assert.equal(view.members.some((member) => member.userId === 45), false);
    assert.equal(view.members.some((member) => member.userId === account), false);
  });
});
