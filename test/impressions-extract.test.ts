import assert from 'node:assert/strict';
import test from 'node:test';
import { buildExtractMessages, asContradictItem, asNewItem, runExtract } from '../src/core/impressions/extract.ts';
import { promptTemplateStore } from '../src/core/prompt/templates.ts';
import { isTagCategoryForScope, prepareTagText } from '../src/core/impressions/tag-model.ts';

const profile = {
  category: 'identity',
  subject: null,
  polarity: null,
  origin: 'self_report',
  sensitive: false,
};

test('new 与 contradict 条目要求合法画像字段', () => {
  const created = asNewItem({ text: 'INTJ', messageId: 'm1', ...profile });
  assert.deepEqual(created, { text: 'INTJ', messageId: 'm1', ...profile });
  assert.equal(asNewItem({ text: 'INTJ', messageId: 'm1', ...profile, category: 'misc' }), undefined);
  assert.equal(asNewItem({ text: '夜猫子', messageId: 'm1', ...profile, category: 'schedule' }), undefined);
  assert.equal(asNewItem({ text: 'INTJ', messageId: 'm1', ...profile, sensitive: 1 }), undefined);
  assert.equal(asNewItem({ text: 'INTJ', messageId: 'm1' }), undefined);
  assert.deepEqual(asNewItem({
    text: 'CS2', messageId: 'm1', ...profile, category: 'topic', subject: '游戏/FPS',
  }), {
    text: 'CS2', messageId: 'm1', ...profile, category: 'topic', subject: '游戏/FPS',
  });
  assert.equal(asNewItem({
    text: 'CS2', messageId: 'm1', ...profile, category: 'topic', subject: '游戏/FPS/CS2',
  }), undefined);

  const contradicted = asContradictItem({
    id: 4,
    text: '爱守望先锋',
    messageId: 'm2',
    category: 'fandom',
    subject: '守望先锋',
    polarity: 'like',
    origin: 'inferred',
    sensitive: true,
  });
  assert.deepEqual(contradicted, {
    id: 4,
    text: '爱守望先锋',
    messageId: 'm2',
    category: 'fandom',
    subject: '守望先锋',
    polarity: 'like',
    origin: 'inferred',
    sensitive: true,
  });
});

test('标签写法校验去前缀、拒绝近况习惯和作息词，并要求梗语为证据原话', () => {
  assert.deepEqual(prepareTagText('personality', '喜欢游戏', []), { ok: true, text: '游戏' });
  assert.deepEqual(prepareTagText('personality', '爱   ', []), { ok: false, reason: 'invalid_text' });
  assert.deepEqual(prepareTagText('recent', '经常搬家', []), { ok: false, reason: 'recent_habit' });
  assert.deepEqual(prepareTagText('personality', '熬夜玩家', []), {
    ok: false,
    reason: 'schedule_by_stats',
  });
  assert.deepEqual(prepareTagText('meme', '今晚不聊政治', ['大家都说今晚不聊政治']), {
    ok: true,
    text: '今晚不聊政治',
  });
  assert.deepEqual(prepareTagText('meme', '0123456789ab', ['引文：0123456789ab']), {
    ok: true,
    text: '0123456789ab',
  });
  assert.deepEqual(prepareTagText('catchphrase', '0123456789abc', ['引文：0123456789abc']), {
    ok: false,
    reason: 'invalid_text',
  });
  assert.deepEqual(prepareTagText('catchphrase', '今天记得早点回家', []), {
    ok: false,
    reason: 'quote_missing',
  });
  assert.deepEqual(prepareTagText('personality', '123456789', []), {
    ok: false,
    reason: 'invalid_text',
  });
  assert.equal(isTagCategoryForScope('positioning', 'group'), true);
  assert.equal(isTagCategoryForScope('positioning', 'member'), false);
  assert.equal(isTagCategoryForScope('catchphrase', 'member'), true);
  assert.equal(isTagCategoryForScope('catchphrase', 'group'), false);
});

test('runExtract returns model errors for the caller instead of discarding them', async () => {
  const error = Object.assign(new Error('synthetic timeout'), { name: 'APIConnectionTimeoutError' });
  const result = await runExtract([], { group: [], members: [] }, promptTemplateStore.get().extractTags, async () => {
    throw error;
  });
  assert.deepEqual(result, { ok: false, reason: 'extract_error', error });
});

test('提取上下文包含现有 tag_subjects canonical names 与 aliases', () => {
  const template = promptTemplateStore.get().extractTags;
  assert.ok(template.system.includes('schedule 只由本地统计或主人手动生成'));
  assert.ok(template.system.includes('group 可用 positioning、topic、atmosphere、meme、norms、recent'));
  assert.ok(template.system.includes('member 可用 identity、personality、fandom、speech、catchphrase'));
  const messages = buildExtractMessages([{
    sessionId: '7:group:8',
    messageId: 'm1',
    senderId: 42,
    senderName: 'A',
    isSelf: false,
    plainText: '喜欢游戏',
    segments: [],
    time: 1,
  }], {
    group: [],
    members: [],
    subjects: [{
      id: 1,
      account: 7,
      category: 'fandom',
      name: '守望先锋',
      aliases: ['OW', 'C.S.G.O.'],
    }],
  }, template);
  const userMessage = messages.find((message) => message.role === 'user');
  const content = String(userMessage?.content ?? '');

  assert.ok(content.includes('守望先锋'));
  assert.ok(content.includes('C.S.G.O.'));
});

test('extract-tags 的固定说明位于可变消息和标签数据之前', () => {
  const template = promptTemplateStore.get().extractTags;
  const first = buildExtractMessages([{
    sessionId: '7:group:8', messageId: 'first', senderId: 42, senderName: '甲',
    isSelf: false, plainText: '第一条消息', segments: [], time: 1,
  }], { group: [], members: [] }, template);
  const second = buildExtractMessages([{
    sessionId: '7:group:8', messageId: 'second', senderId: 43, senderName: '乙',
    isSelf: false, plainText: '另一条消息', segments: [], time: 60_001,
  }], { group: [], members: [] }, template);
  const fixedPrefix = '以下是该群最近的消息（每行开头是 #消息ID，括号里是发送者 QQ 号）：\n'
    + '该群已有标签与可复用的 tag_subjects（群标签、群友标签附 id 与状态；subject 附规范名和别名）：\n';

  assert.equal(first[0]?.content, second[0]?.content);
  assert.ok(String(first[1]?.content).startsWith(fixedPrefix));
  assert.ok(String(second[1]?.content).startsWith(fixedPrefix));
  assert.notEqual(first[1]?.content, second[1]?.content);
});

test('locked 标签不会进入 extract-tags 的 existing 上下文', () => {
  const lockedTag = {
    id: 9,
    account: 7,
    sessionId: '7:group:8',
    userId: 42,
    text: '不应进入模型的敏感标签',
    norm: '不应进入模型的敏感标签',
    category: 'personality' as const,
    subject: null,
    polarity: null,
    origin: 'inferred' as const,
    locked: true,
    status: 'confirmed' as const,
    source: 'auto' as const,
    samples: 1,
    evidence: [],
    firstSeen: 1,
    lastSeen: 1,
    supersededBy: null,
    updatedAt: 1,
  };
  const messages = buildExtractMessages([{
    sessionId: '7:group:8',
    messageId: 'm1',
    senderId: 42,
    senderName: 'A',
    isSelf: false,
    plainText: '普通消息',
    segments: [],
    time: 1,
  }], {
    group: [lockedTag],
    members: [{ userId: 42, tags: [lockedTag] }],
    subjects: [],
  }, promptTemplateStore.get().extractTags);

  assert.ok(!messages.map((message) => String(message.content)).join('\n').includes(lockedTag.text));
  assert.ok(!messages.map((message) => String(message.content)).join('\n').includes('#9'));
});
