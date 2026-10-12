import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/store/db.ts';
import { createRepository } from '../src/store/repository.ts';

function withRepository<T>(run: (repository: ReturnType<typeof createRepository>) => T): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-store-'));
  const database = openDatabase(path.join(root, 'aquarium.db'));
  try {
    return run(createRepository(database, () => new Date(2026, 9, 12, 12, 0, 0)));
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function messageRecord(messageId: string, time: number, isSelf = false) {
  return {
    sessionId: '900000001:group:123456',
    messageId,
    senderId: isSelf ? 900000001 : 42,
    senderName: isSelf ? 'Aquarium' : '群友',
    isSelf,
    plainText: `消息-${messageId}`,
    segments: [{ type: 'text', text: `消息-${messageId}` }],
    time,
  };
}

test('saveMessage 去重并让 recentMessages 由旧到新返回', () => {
  withRepository((repository) => {
    assert.equal(repository.saveMessage(messageRecord('newer', 2000)), true);
    assert.equal(repository.saveMessage(messageRecord('older', 1000, true)), true);
    assert.equal(repository.saveMessage(messageRecord('older', 3000)), false);

    const recent = repository.recentMessages('900000001:group:123456', 2);

    assert.deepEqual(recent.map((message) => message.messageId), ['older', 'newer']);
    assert.equal(recent[0]?.isSelf, true);
    assert.equal(recent[0]?.time, 1000);
    assert.deepEqual(recent[1]?.segments, [{ type: 'text', text: '消息-newer' }]);
  });
});

test('costToday 只累计本地自然日内的用量', () => {
  withRepository((repository) => {
    const dayStart = new Date(2026, 9, 12).getTime();
    const nextDay = new Date(2026, 9, 13).getTime();
    const record = (time: number, cost: number) => repository.recordUsage({
      time,
      slot: 'reply',
      provider: 'deepseek',
      model: 'test-model',
      inputTokens: 10,
      cachedTokens: 0,
      outputTokens: 4,
      costCny: cost,
      latencyMs: 50,
      ok: true,
    });

    record(dayStart - 1, 100);
    record(dayStart, 1);
    record(nextDay - 1, 2);
    record(nextDay, 100);

    assert.equal(repository.costToday(), 3);
  });
});

test('setCaption 覆盖已有描述，缺失 key 返回 undefined', () => {
  withRepository((repository) => {
    assert.equal(repository.getCaption('image-a'), undefined);
    repository.setCaption('image-a', '第一版', 10);
    repository.setCaption('image-a', '更新版', 20);

    assert.equal(repository.getCaption('image-a'), '更新版');
  });
});

test('recentDecisions 返回最新决策并还原 detail JSON', () => {
  withRepository((repository) => {
    repository.recordDecision({
      time: 1,
      sessionId: '900000001:private:42',
      messageId: 'a',
      replied: false,
      reason: 'disabled',
      detail: { enabled: false },
    });
    repository.recordDecision({
      time: 2,
      sessionId: '900000001:private:42',
      messageId: 'b',
      replied: true,
      reason: 'replied',
      detail: { model: 'fake' },
    });

    const decisions = repository.recentDecisions(1);

    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]?.messageId, 'b');
    assert.equal(decisions[0]?.replied, true);
    assert.deepEqual(decisions[0]?.detail, { model: 'fake' });
  });
});

test('lastSelfMessage 返回指定会话最近一条 bot 消息', () => {
  withRepository((repository) => {
    const sessionKey = '900000001:group:123456';
    repository.saveMessage(messageRecord('incoming', 1000, false));
    repository.saveMessage(messageRecord('self-old', 2000, true));
    repository.saveMessage(messageRecord('self-new', 3000, true));

    assert.equal(repository.lastSelfMessage(sessionKey)?.messageId, 'self-new');
    assert.equal(repository.lastSelfMessage('900000001:private:42'), undefined);
  });
});
