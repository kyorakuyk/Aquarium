import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPrivateExtractionMessages, parsePrivateFactResponse } from '../src/core/privacy/extract.ts';
import { promptTemplateStore } from '../src/core/prompt/templates.ts';
import type { MessageStorageRecord } from '../src/store/repository.ts';

const sessionId = '900000001:private:42';
const template = {
  source: '',
  version: 'private-extract-v1',
  system: '只输出 JSON',
  user: '对话：{{context}}\n现有：{{existing}}',
};

function message(patch: Partial<MessageStorageRecord> = {}): MessageStorageRecord {
  return {
    sessionId,
    messageId: 'private-1',
    senderId: 42,
    senderName: '小明',
    isSelf: false,
    plainText: '最近开始准备考研。',
    segments: [],
    time: new Date(2026, 9, 20, 9, 5).getTime(),
    ...patch,
  };
}

test('private extraction messages distinguish the owner from the bot and include active fact ids', () => {
  const messages = buildPrivateExtractionMessages({
    records: [
      message(),
      message({ messageId: 'bot-1', senderId: 900000001, senderName: '眷属', isSelf: true, plainText: '加油。' }),
    ],
    ownerId: 42,
    existing: [{ id: 7, text: '正在准备考试', keywords: ['考试', '学习'] }],
    template,
  });
  const content = String(messages[1]?.content);

  assert.equal(messages[0]?.role, 'system');
  assert.equal(messages[0]?.content, '只输出 JSON');
  assert.ok(content.includes('对方'));
  assert.ok(content.includes('眷属'));
  assert.ok(content.includes('#private-1'));
  assert.ok(content.includes('#bot-1'));
  assert.ok(content.includes('#7 正在准备考试'));
  assert.equal(content.includes('QQ 42'), false);
});

test('private extraction puts fixed instructions before changing records and facts', () => {
  const template = promptTemplateStore.get().extractPrivate;
  const first = buildPrivateExtractionMessages({
    records: [message()],
    ownerId: 42,
    existing: [],
    template,
  });
  const second = buildPrivateExtractionMessages({
    records: [message({ messageId: 'private-2', plainText: '已经开始新的计划。', time: new Date(2026, 9, 20, 9, 6).getTime() })],
    ownerId: 42,
    existing: [{ id: 7, text: '正在准备考试', keywords: ['考试', '学习'] }],
    template,
  });
  const fixedInstruction = '请只输出 new、update、obsolete 三个数组组成的 JSON。每个 text 必须有窗口内对方消息作为依据。';

  assert.equal(first[0]?.content, second[0]?.content);
  assert.ok(String(first[1]?.content).startsWith(fixedInstruction));
  assert.ok(String(second[1]?.content).startsWith(fixedInstruction));
  assert.notEqual(first[1]?.content, second[1]?.content);
});

test('private extraction parser requires all result arrays and preserves item fields', () => {
  const parsed = parsePrivateFactResponse(JSON.stringify({
    new: [{ text: '喜欢周末爬山', keywords: ['周末', '爬山'], messageId: 'private-2' }],
    update: [{ id: 7, text: '开始每周末爬山', keywords: ['周末', '爬山'], messageId: 'private-3' }],
    obsolete: [{ id: 8 }],
  }));

  assert.equal(parsed?.new.length, 1);
  assert.equal(parsed?.update.length, 1);
  assert.equal(parsed?.obsolete.length, 1);
  assert.equal(parsePrivateFactResponse('{"new":[]}'), undefined);
  assert.equal(parsePrivateFactResponse('not JSON'), undefined);
});
