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

test('messagesInRange returns only the inclusive time window in ascending order', () => {
  withRepository((repository) => {
    const session = '900000001:group:123456';
    repository.saveMessage(messageRecord('before', 999));
    repository.saveMessage(messageRecord('end', 2500));
    repository.saveMessage(messageRecord('middle', 2000));
    repository.saveMessage(messageRecord('start', 1500));
    repository.saveMessage({ ...messageRecord('other-session', 1800), sessionId: '900000001:group:654321' });

    const records = repository.messagesInRange(session, 1500, 2500);

    assert.deepEqual(records.map((record) => record.messageId), ['start', 'middle', 'end']);
    assert.throws(() => repository.messagesInRange(session, 2500, 1500), /时间范围/u);
  });
});

test('decisionsInRange 返回指定会话内的闭区间决策', () => {
  withRepository((repository) => {
    const session = '900000001:group:123456';
    repository.recordDecision({ time: 1000, sessionId: session, messageId: 'before', replied: true, reason: 'replied', detail: {} });
    repository.recordDecision({ time: 1500, sessionId: session, messageId: 'start', replied: true, reason: 'replied', detail: { stickerSent: 3 } });
    repository.recordDecision({ time: 2500, sessionId: session, messageId: 'end', replied: false, reason: 'empty_reply', detail: {} });
    repository.recordDecision({ time: 1800, sessionId: 'other-session', messageId: 'other', replied: true, reason: 'replied', detail: {} });

    const records = repository.decisionsInRange(session, 1500, 2500);

    assert.deepEqual(records.map((record) => record.messageId), ['start', 'end']);
    assert.equal(records[0]?.detail && typeof records[0].detail === 'object'
      ? (records[0].detail as Record<string, unknown>).stickerSent
      : undefined, 3);
    assert.throws(() => repository.decisionsInRange(session, 2500, 1500), /时间范围/u);
  });
});

 test('costToday 只累计本地自然日内的用量', () => {
  withRepository((repository) => {
    const dayStart = new Date(2026, 9, 12).getTime();
    const nextDay = new Date(2026, 9, 13).getTime();
    const record = (time: number, cost: number) => repository.recordUsage({
      time,
      account: null,
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

test('表情按账号和 md5 去重，保存相对文件名与描述状态', () => {
  withRepository((repository) => {
    const md5 = '0123456789abcdef0123456789abcdef';
    const detail = {
      account: 900000001,
      emojiId: 'emoji-one',
      md5,
      descQq: 'QQ 备注',
    };
    const inserted = repository.upsertSticker(detail, 100);
    assert.equal(inserted.inserted, true);
    repository.setStickerFile(inserted.sticker.id, `${md5}.gif`, 101);
    repository.saveStickerDescription(inserted.sticker.id, '开心啦', ['开心'], 102);

    const duplicate = repository.upsertSticker({ ...detail, emojiId: 'emoji-two' }, 103);
    assert.equal(duplicate.inserted, false);
    assert.equal(duplicate.sticker.id, inserted.sticker.id);
    assert.equal(duplicate.sticker.emojiId, 'emoji-two');
    assert.equal(duplicate.sticker.file, `${md5}.gif`);
    assert.equal(duplicate.sticker.descAi, '开心啦');
    assert.deepEqual(duplicate.sticker.tags, ['开心']);
    assert.equal(duplicate.sticker.descriptionAttempts, 1);
    const used = repository.recordStickerUse(inserted.sticker.id, 106);
    assert.equal(used?.useCount, 1);
    assert.equal(used?.lastUsedAt, 106);

    repository.markMissingStickers(detail.account, [], 104);
    assert.equal(repository.stickerById(inserted.sticker.id)?.missing, true);
    const restored = repository.upsertSticker(detail, 105);
    assert.equal(restored.sticker.missing, false);
    assert.equal(repository.listStickers(detail.account).length, 1);
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

    repository.recordDecision({
      time: 3,
      sessionId: '900000001:private:42',
      messageId: 'skip-after-reply',
      replied: false,
      reason: 'disabled',
      detail: {},
    });
    assert.equal(repository.latestReplyDecision()?.messageId, 'b');
  });
});

test('回复统计按本地自然日和账号隔离', () => {
  withRepository((repository) => {
    const dayStart = new Date(2026, 9, 12).getTime();
    repository.recordDecision({
      time: dayStart,
      sessionId: '900000001:group:123456',
      messageId: 'reply-a',
      replied: true,
      reason: 'replied',
      detail: {},
    });
    repository.recordDecision({
      time: dayStart + 1,
      sessionId: '99999:private:42',
      messageId: 'reply-b',
      replied: true,
      reason: 'replied',
      detail: {},
    });
    repository.recordDecision({
      time: dayStart + 2,
      sessionId: '900000001:group:123456',
      messageId: 'skip-c',
      replied: false,
      reason: 'disabled',
      detail: {},
    });

    assert.equal(repository.replyCountToday(), 2);
    assert.equal(repository.replyCountTodayForAccount(900000001), 1);
    assert.equal(repository.replyCountTodayForAccount(99999), 1);
  });
});

test('lastSelfMessage 返回指定会话最近一条 bot 消息', () => {
  withRepository((repository) => {
    const sessionKey = '900000001:group:123456';
    repository.saveMessage(messageRecord('incoming', 1000, false));
    repository.saveMessage(messageRecord('self-old', 2000, true));
    repository.saveMessage(messageRecord('self-new', 3000, true));

    assert.equal(repository.lastSelfMessage(sessionKey)?.messageId, 'self-new');
    assert.equal(repository.latestSelfMessageForAccount(900000001)?.messageId, 'self-new');
    assert.equal(repository.lastSelfMessage('900000001:private:42'), undefined);
  });
});

test('lastMessageBefore 只返回批次首条消息之前的最近会话消息', () => {
  withRepository((repository) => {
    const sessionKey = '900000001:group:123456';
    repository.saveMessage(messageRecord('older', 1_000));
    repository.saveMessage(messageRecord('same-time', 2_000));
    repository.saveMessage(messageRecord('newer', 3_000));

    assert.equal(repository.lastMessageBefore(sessionKey, 2_000)?.messageId, 'older');
    assert.equal(repository.lastMessageBefore(sessionKey, 1_000), undefined);
  });
});

test('情绪状态与事件读写往返一致', () => {
  withRepository((repository) => {
    assert.equal(repository.getMoodState(900000001), undefined);

    repository.saveMoodState({
      account: 900000001,
      valence: 0.32,
      arousal: 0.55,
      updatedAt: 5_000,
      band: 'happy',
      bandSince: 4_000,
      lastBandChangeAt: 3_000,
    });
    repository.saveMoodState({
      account: 900000001,
      valence: -0.28,
      arousal: 0.71,
      updatedAt: 6_000,
      band: 'annoyed',
      bandSince: 6_000,
      lastBandChangeAt: 6_000,
    });
    assert.deepEqual(repository.getMoodState(900000001), {
      account: 900000001,
      valence: -0.28,
      arousal: 0.71,
      updatedAt: 6_000,
      band: 'annoyed',
      bandSince: 6_000,
      lastBandChangeAt: 6_000,
    });

    repository.recordMoodEvent({
      account: 900000001,
      time: 7_000,
      source: 'appraise',
      sessionId: '900000001:group:123456',
      senderId: 42,
      dv: 0.12,
      da: -0.05,
      appliedDv: 0.12,
      appliedDa: -0.05,
      reason: '被说好话',
      bandBefore: 'calm',
      bandAfter: 'happy',
      valenceAfter: 0.16,
      arousalAfter: 0.66,
    });
    repository.recordMoodEvent({
      account: 900000001,
      time: 8_000,
      source: 'rule',
      sessionId: '900000001:private:42',
      senderId: null,
      dv: 0,
      da: 0.05,
      appliedDv: 0,
      appliedDa: 0.05,
      reason: '被叫',
      bandBefore: null,
      bandAfter: null,
      valenceAfter: -0.28,
      arousalAfter: 0.76,
    });

    const recent = repository.recentMoodEvents(900000001, 5);
    assert.equal(recent.length, 2);
    assert.equal(recent[0]?.time, 8_000);
    assert.equal(recent[1]?.senderId, 42);
    assert.equal(recent[1]?.bandBefore, 'calm');
    assert.equal(recent[1]?.bandAfter, 'happy');
    assert.equal(recent[1]?.valenceAfter, 0.16);
    assert.equal(recent[1]?.arousalAfter, 0.66);
    assert.equal(recent[0]?.sessionId, '900000001:private:42');
    assert.equal(repository.latestMoodEventAtOrBefore(900000001, 7_500)?.id, 1);
    assert.deepEqual(repository.recentMoodEvents(900000001, 0), []);
    assert.deepEqual(repository.recentMoodEvents(99999, 5), []);

    const since = repository.moodEventsSince(900000001, 7_500);
    assert.deepEqual(since.map((event) => event.time), [8_000]);
  });
});

test('标签与提取进度读写往返一致', () => {
  withRepository((repository) => {
    const account = 900000001;
    const groupSession = '900000001:group:123456';
    assert.deepEqual(repository.listTagsForSubject(account, groupSession, null), []);
    assert.equal(repository.getTagRun(account, groupSession), undefined);

    const groupTagId = repository.insertTag({
      account,
      sessionId: groupSession,
      userId: null,
      text: '爱聊游戏',
      norm: '爱聊游戏',
      status: 'candidate',
      source: 'auto',
      samples: 1,
      evidence: [{ messageId: 'm1', time: 1_000, quote: '今晚开黑吗' }],
      firstSeen: 1_000,
      lastSeen: 1_000,
      supersededBy: null,
      updatedAt: 1_000,
    });
    const memberTagId = repository.insertTag({
      account,
      sessionId: groupSession,
      userId: 42,
      text: '夜猫子',
      norm: '夜猫子',
      status: 'confirmed',
      source: 'auto',
      samples: 3,
      evidence: [{ messageId: 'm2', time: 2_000, quote: '凌晨还在' }],
      firstSeen: 1_000,
      lastSeen: 2_000,
      supersededBy: null,
      updatedAt: 2_000,
    });

    const groupTags = repository.listTagsForSubject(account, groupSession, null);
    assert.equal(groupTags.length, 1);
    assert.equal(groupTags[0]?.id, groupTagId);
    assert.equal(groupTags[0]?.userId, null);
    assert.deepEqual(groupTags[0]?.evidence, [{ messageId: 'm1', time: 1_000, quote: '今晚开黑吗' }]);
    const memberTags = repository.listTagsForSubject(account, groupSession, 42);
    assert.equal(memberTags.length, 1);
    assert.equal(memberTags[0]?.id, memberTagId);
    assert.equal(memberTags[0]?.samples, 3);

    repository.updateTag(groupTagId, {
      status: 'confirmed',
      samples: 2,
      evidence: [
        { messageId: 'm1', time: 1_000, quote: '今晚开黑吗' },
        { messageId: 'm3', time: 3_000, quote: '组队走起' },
      ],
      lastSeen: 3_000,
      updatedAt: 3_000,
    });
    const updated = repository.tagById(groupTagId);
    assert.equal(updated?.status, 'confirmed');
    assert.equal(updated?.samples, 2);
    assert.equal(updated?.lastSeen, 3_000);
    assert.equal(updated?.evidence.length, 2);
    assert.equal(repository.tagById(99999), undefined);

    repository.saveTagRun({ account, sessionId: groupSession, lastRunAt: 4_000, lastMessageTime: 3_500 });
    repository.saveTagRun({ account, sessionId: groupSession, lastRunAt: 5_000, lastMessageTime: 4_500 });
    assert.deepEqual(repository.getTagRun(account, groupSession), {
      account,
      sessionId: groupSession,
      lastRunAt: 5_000,
      lastMessageTime: 4_500,
    });
  });
});

test('好感度状态与事件读写往返一致', () => {
  withRepository((repository) => {
    const account = 900000001;
    const userId = 42;
    const state = {
      account,
      userId,
      value: 72.5,
      level: 'warm' as const,
      levelSince: 2_000,
      lastLevelChangeAt: 2_000,
      lastInteractionAt: 3_000,
      updatedAt: 3_000,
    };
    repository.saveAffinityState(state);
    assert.deepEqual(repository.getAffinityState(account, userId), state);
    assert.deepEqual(repository.listAffinityStates(account), [state]);

    const event = {
      account,
      userId,
      time: 4_000,
      source: 'appraise' as const,
      sessionId: '900000001:group:123456',
      delta: 0.5,
      applied: 0.5,
      reason: '正向情绪事件',
      levelBefore: 'neutral' as const,
      levelAfter: 'warm' as const,
    };
    repository.recordAffinityEvent(event);
    assert.deepEqual(repository.recentAffinityEvents(account, userId, 5), [{ id: 1, ...event }]);
  });
});

test('人设版本存储读写往返一致', () => {
  withRepository((repository) => {
    const markdown = '# 归档人设\n\n## 说话方式\n简洁。';
    const traitsJson = JSON.stringify({ order: 0, morality: 0, talk: 1, mind: 0, humor: 0, openness: 0, imitation: 0 });
    const id = repository.recordPersonaVersion('archive', markdown, traitsJson);

    assert.deepEqual(repository.personaVersions('archive', 50), [{
      id,
      personaId: 'archive',
      savedAt: new Date(2026, 9, 12, 12, 0, 0).getTime(),
      markdown,
      traitsJson,
      note: null,
    }]);
    assert.equal(repository.personaVersion('archive', id)?.markdown, markdown);
    assert.equal(repository.personaVersion('other', id), undefined);
  });
});
