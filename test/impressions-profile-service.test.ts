import assert from 'node:assert/strict';
import test from 'node:test';
import { createImpressionsService } from '../src/core/impressions/service.ts';
import { sessionId, type SessionKey } from '../src/core/shared/events.ts';
import { promptTemplateStore } from '../src/core/prompt/templates.ts';
import { openDatabase } from '../src/store/db.ts';
import { createRepository } from '../src/store/repository.ts';
import { createTagSubjectRepository } from '../src/store/tag-subject-repo.ts';
import type { MessageStorageRecord } from '../src/store/repository.ts';
import { groupSession, makeConfig } from './pipeline-test-helpers.ts';

const at = new Date(2026, 9, 20, 12).getTime();
const key = sessionId(groupSession);

function message(messageId: string, senderId: number, plainText: string): MessageStorageRecord {
  return {
    sessionId: key,
    messageId,
    senderId,
    senderName: `成员${senderId}`,
    isSelf: false,
    plainText,
    segments: [],
    time: at,
  };
}

async function runWindow(
  repository: ReturnType<typeof createRepository>,
  subjects: ReturnType<typeof createTagSubjectRepository>,
  records: MessageStorageRecord[],
  response: unknown,
) {
  const prompts: string[] = [];
  const service = createImpressionsService({
    repository,
    tagSubjects: subjects,
    getConfig: () => makeConfig({ nicknames: [] }),
    now: () => at,
    callModel: async (_slot, messages) => {
      prompts.push(String(messages[1]?.content ?? ''));
      return {
        text: JSON.stringify(response),
        provider: 'fake',
        model: 'fake-model',
        usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
      };
    },
  });
  const release = service.tryAcquireSession(key);
  assert.ok(release);
  const summary = await service.extractWindowUnderSessionLock({
    session: groupSession as SessionKey,
    records,
    now: at,
    template: promptTemplateStore.get().extractTags,
  });
  release();
  return { prompts, summary };
}

test('分类校验、identity 自述降级与 sensitive 锁定在真实提取入口生效', async () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    const subjects = createTagSubjectRepository(database);
    const response = {
      group: { observe: [], new: [], contradict: [] },
      members: [
        {
          userId: 42,
          observe: [],
          new: [
            { text: 'INTJ', messageId: 'm1', category: 'identity', subject: null, polarity: null, origin: 'self_report', sensitive: false },
            { text: 'INFJ', messageId: 'm2', category: 'identity', subject: null, polarity: null, origin: 'self_report', sensitive: false },
            { text: '焦虑', messageId: 'm3', category: 'personality', subject: null, polarity: null, origin: 'inferred', sensitive: true },
          ],
          contradict: [],
        },
        {
          userId: 43,
          observe: [],
          new: [
            { text: '错误类别', messageId: 'm4', category: 'misc', subject: null, polarity: null, origin: 'inferred', sensitive: false },
            { text: '不是类型', messageId: 'm4', category: 'identity', subject: null, polarity: null, origin: 'inferred', sensitive: false },
            { text: '群里很热闹', messageId: 'm4', category: 'atmosphere', subject: null, polarity: null, origin: 'inferred', sensitive: false },
          ],
          contradict: [],
        },
      ],
    };
    const { summary } = await runWindow(repository, subjects, [
      message('m1', 42, '我是INTJ'),
      message('m2', 42, '最近在玩游戏'),
      message('m3', 42, '我有些焦虑'),
      message('m4', 43, '不是类型'),
    ], response);

    const tags = repository.listTagsForSubject(groupSession.account, key, 42);
    assert.equal(summary.dropped, 3);
    assert.equal(tags.find((tag) => tag.text === 'INTJ')?.origin, 'self_report');
    assert.equal(tags.find((tag) => tag.text === 'INTJ')?.status, 'candidate');
    assert.equal(tags.find((tag) => tag.text === 'INFJ')?.origin, 'inferred');
    assert.equal(tags.find((tag) => tag.text === 'INFJ')?.status, 'candidate');
    assert.equal(tags.find((tag) => tag.text === '焦虑')?.locked, true);
    assert.equal(repository.listTagsForSubject(groupSession.account, key, 43).length, 0);
  } finally {
    database.close();
  }
});

test('inferred identity 在自动观察达到阈值后仍保持 candidate', async () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    const subjects = createTagSubjectRepository(database);
    const id = repository.insertTag({
      account: groupSession.account,
      sessionId: key,
      userId: 42,
      text: 'ENFP',
      norm: 'ENFP',
      category: 'identity',
      subject: null,
      polarity: null,
      origin: 'inferred',
      locked: false,
      status: 'candidate',
      source: 'auto',
      samples: 1,
      evidence: [{ messageId: 'seed', time: at - 1_000, quote: '可能是 ENFP' }],
      firstSeen: at - 1_000,
      lastSeen: at - 1_000,
      supersededBy: null,
      updatedAt: at - 1_000,
    });
    await runWindow(repository, subjects, [message('m1', 42, '今天聊得很开心')], {
      group: { observe: [], new: [], contradict: [] },
      members: [{ userId: 42, observe: [{ id, messageId: 'm1' }], new: [], contradict: [] }],
    });

    const updated = repository.tagById(id);
    assert.equal(updated?.samples, 2);
    assert.equal(updated?.status, 'candidate');
  } finally {
    database.close();
  }
});

test('self_report identity 的发言者不匹配时降级为 inferred candidate', async () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    const subjects = createTagSubjectRepository(database);
    await runWindow(repository, subjects, [
      message('owner-message', 44, '今天在线'),
      message('other-message', 43, '小明是INTP'),
    ], {
      group: { observe: [], new: [], contradict: [] },
      members: [{
        userId: 44,
        observe: [],
        new: [{ text: 'INTP', messageId: 'other-message', category: 'identity', subject: null, polarity: null, origin: 'self_report', sensitive: false }],
        contradict: [],
      }],
    });

    const stored = repository.listTagsForSubject(groupSession.account, key, 44)[0];
    assert.equal(stored?.origin, 'inferred');
    assert.equal(stored?.status, 'candidate');
    assert.equal(stored?.evidence[0]?.messageId, 'other-message');
  } finally {
    database.close();
  }
});

test('新提取识别出已有敏感标签后立即锁定', async () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    const subjects = createTagSubjectRepository(database);
    const id = repository.insertTag({
      account: groupSession.account,
      sessionId: key,
      userId: 42,
      text: '焦虑',
      norm: '焦虑',
      category: 'personality',
      subject: null,
      polarity: null,
      origin: 'inferred',
      locked: false,
      status: 'confirmed',
      source: 'auto',
      samples: 2,
      evidence: [{ messageId: 'seed', time: at - 1_000, quote: '最近有些焦虑' }],
      firstSeen: at - 1_000,
      lastSeen: at - 1_000,
      supersededBy: null,
      updatedAt: at - 1_000,
    });
    await runWindow(repository, subjects, [message('m1', 42, '我有点焦虑')], {
      group: { observe: [], new: [], contradict: [] },
      members: [{
        userId: 42,
        observe: [],
        new: [{ text: '焦虑', messageId: 'm1', category: 'personality', subject: null, polarity: null, origin: 'inferred', sensitive: true }],
        contradict: [],
      }],
    });

    assert.equal(repository.tagById(id)?.locked, true);
  } finally {
    database.close();
  }
});

test('locked 标签的 id 不会让模型观察结果改写其证据', async () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    const subjects = createTagSubjectRepository(database);
    const id = repository.insertTag({
      account: groupSession.account,
      sessionId: key,
      userId: 42,
      text: '锁定内容',
      norm: '锁定内容',
      category: 'personality',
      subject: null,
      polarity: null,
      origin: 'inferred',
      locked: true,
      status: 'confirmed',
      source: 'auto',
      samples: 1,
      evidence: [{ messageId: 'seed', time: at - 1_000, quote: '锁定内容' }],
      firstSeen: at - 1_000,
      lastSeen: at - 1_000,
      supersededBy: null,
      updatedAt: at - 1_000,
    });
    const { summary } = await runWindow(repository, subjects, [message('m1', 42, '新消息')], {
      group: { observe: [], new: [], contradict: [] },
      members: [{ userId: 42, observe: [{ id, messageId: 'm1' }], new: [], contradict: [] }],
    });

    const unchanged = repository.tagById(id);
    assert.equal(summary.dropped, 1);
    assert.equal(unchanged?.samples, 1);
    assert.equal(unchanged?.lastSeen, at - 1_000);
    assert.deepEqual(unchanged?.evidence.map(({ messageId }) => messageId), ['seed']);
  } finally {
    database.close();
  }
});

test('提取会话携带 tag_subjects 并在 fandom 标签落库前复用 canonical name', async () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    const subjects = createTagSubjectRepository(database);
    subjects.saveTagSubject({
      account: groupSession.account,
      category: 'fandom',
      name: '守望先锋',
      aliases: ['OW', 'Overwatch'],
    });
    const { prompts } = await runWindow(repository, subjects, [message('m1', 42, '喜欢OW')], {
      group: { observe: [], new: [], contradict: [] },
      members: [{
        userId: 42,
        observe: [],
        new: [{ text: '喜欢游戏', messageId: 'm1', category: 'fandom', subject: 'OW', polarity: 'like', origin: 'inferred', sensitive: false }],
        contradict: [],
      }],
    });

    assert.ok(prompts[0]?.includes('守望先锋'));
    assert.ok(prompts[0]?.includes('Overwatch'));
    assert.equal(repository.listTagsForSubject(groupSession.account, key, 42)[0]?.subject, '守望先锋');
  } finally {
    database.close();
  }
});
