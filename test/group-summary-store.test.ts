import assert from 'node:assert/strict';
import test from 'node:test';
import { createRepository } from '../src/store/repository.ts';
import { openDatabase } from '../src/store/db.ts';

test('schema v24 persists group summaries and recent schedule drops', () => {
  const database = openDatabase(':memory:');
  try {
    const version = database.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number };
    const groupSummaryColumns = (database.prepare("PRAGMA table_info('group_summaries')").all() as Array<{ name: string }>)
      .map(({ name }) => name);
    const dropColumns = (database.prepare("PRAGMA table_info('tag_drop_events')").all() as Array<{ name: string }>)
      .map(({ name }) => name);

    assert.equal(version.version, 24);
    assert.deepEqual(groupSummaryColumns, ['account', 'session_id', 'text', 'manual', 'updated_at']);
    assert.deepEqual(dropColumns, ['id', 'account', 'session_id', 'user_id', 'category', 'text', 'reason', 'time']);
  } finally {
    database.close();
  }
});

test('group summaries persist, automatic writes preserve manual text, and schedule drops are scoped', () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    const getGroupSummary = Reflect.get(repository, 'getGroupSummary') as ((account: number, sessionId: string) => unknown) | undefined;
    const saveGeneratedGroupSummary = Reflect.get(repository, 'saveGeneratedGroupSummary') as ((input: unknown) => boolean) | undefined;
    const saveManualGroupSummary = Reflect.get(repository, 'saveManualGroupSummary') as ((input: unknown) => void) | undefined;
    const recordTagDrop = Reflect.get(repository, 'recordTagDrop') as ((input: unknown) => void) | undefined;
    const latestScheduleDrop = Reflect.get(repository, 'latestScheduleDrop') as (
      (account: number, sessionId: string, userId: number | null, since: number) => unknown
    ) | undefined;
    const deleteTagDropsForSession = Reflect.get(repository, 'deleteTagDropsForSession') as (
      (account: number, sessionId: string) => number
    ) | undefined;

    for (const method of [getGroupSummary, saveGeneratedGroupSummary, saveManualGroupSummary, recordTagDrop, latestScheduleDrop, deleteTagDropsForSession]) {
      assert.equal(typeof method, 'function');
    }
    if (!getGroupSummary || !saveGeneratedGroupSummary || !saveManualGroupSummary
      || !recordTagDrop || !latestScheduleDrop || !deleteTagDropsForSession) return;

    const groupId = '900000001:group:123456';
    const generated = { account: 900000001, sessionId: groupId, text: '晚间活跃的游戏群。', updatedAt: 100 };
    assert.equal(saveGeneratedGroupSummary(generated), true);
    assert.deepEqual(getGroupSummary(900000001, groupId), { ...generated, manual: false });
    saveManualGroupSummary({ account: 900000001, sessionId: groupId, text: '主人写的群摘要。', updatedAt: 200 });
    assert.equal(saveGeneratedGroupSummary({ ...generated, text: '自动摘要不可覆盖。', updatedAt: 300 }), false);
    assert.deepEqual(getGroupSummary(900000001, groupId), {
      account: 900000001,
      sessionId: groupId,
      text: '主人写的群摘要。',
      manual: true,
      updatedAt: 200,
    });

    recordTagDrop({
      account: 900000001,
      sessionId: groupId,
      userId: null,
      category: 'speech',
      text: '常深夜打游戏',
      reason: 'schedule_by_stats',
      time: 500,
    });
    recordTagDrop({
      account: 900000001,
      sessionId: groupId,
      userId: 42,
      category: 'recent',
      text: '最近总是熬夜',
      reason: 'schedule_by_stats',
      time: 600,
    });
    assert.deepEqual(latestScheduleDrop(900000001, groupId, null, 100), {
      id: 1,
      account: 900000001,
      sessionId: groupId,
      userId: null,
      category: 'speech',
      text: '常深夜打游戏',
      reason: 'schedule_by_stats',
      time: 500,
    });
    assert.equal(latestScheduleDrop(900000001, groupId, 42, 100) !== undefined, true);
    assert.equal(latestScheduleDrop(900000001, groupId, null, 501), undefined);
    assert.equal(deleteTagDropsForSession(900000001, groupId), 2);
  } finally {
    database.close();
  }
});

test('member message statistics count non-self chat records and use their latest local timestamp', () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    const groupId = '900000001:group:123456';
    for (const message of [
      { senderId: 42, messageId: 'first', time: 100, isSelf: false },
      { senderId: 43, messageId: 'other', time: 150, isSelf: false },
      { senderId: 42, messageId: 'latest', time: 200, isSelf: false },
      { senderId: 900000001, messageId: 'bot', time: 300, isSelf: true },
    ]) {
      repository.saveMessage({
        sessionId: groupId,
        messageId: message.messageId,
        senderId: message.senderId,
        senderName: `成员${message.senderId}`,
        isSelf: message.isSelf,
        plainText: '测试消息',
        segments: [],
        time: message.time,
      });
    }

    assert.deepEqual(repository.memberMessageStats(groupId), [
      { userId: 42, messageCount: 2, lastMessageTime: 200 },
      { userId: 43, messageCount: 1, lastMessageTime: 150 },
    ]);
  } finally {
    database.close();
  }
});
