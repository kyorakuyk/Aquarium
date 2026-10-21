import assert from 'node:assert/strict';
import test from 'node:test';
import { buildImpressionsPromptBlocks, relationPromptLines } from '../src/core/impressions/prompt-blocks.ts';
import type { SessionKey } from '../src/core/shared/events.ts';
import { sessionId } from '../src/core/shared/events.ts';
import { promptTemplateStore } from '../src/core/prompt/templates.ts';
import { createRepository } from '../src/store/repository.ts';
import { openDatabase } from '../src/store/db.ts';

const account = 91001;
const groupId = 92002;
const userId = 93003;
const now = Date.UTC(2026, 9, 21, 12);
const session: SessionKey = { account, kind: 'group', peer: groupId };

test('member prompt includes only allowed QQ identity fields and redacts profile text', () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database, () => new Date(now));
    const key = sessionId(session);
    repository.insertTag({
      account,
      sessionId: key,
      userId,
      text: '乐于助人',
      norm: '乐于助人',
      category: 'personality',
      subject: null,
      polarity: null,
      origin: 'inferred',
      locked: false,
      status: 'confirmed',
      source: 'manual',
      samples: 1,
      evidence: [],
      firstSeen: now,
      lastSeen: now,
      supersededBy: null,
      updatedAt: now,
    });
    repository.setAccountKind(account, userId, 'bot', now);
    const credential = ['K8p4Q2m7', 'R5x1'].join('');
    repository.saveQqGroupProfile({
      account,
      groupId,
      json: JSON.stringify({ groupInfo: null, honors: null, latestNotice: null, essenceCount: null, membersAvailable: true }),
      fetchedAt: now,
    });
    repository.replaceQqMemberProfiles(account, groupId, [{
      account,
      groupId,
      userId,
      json: JSON.stringify({
        userId,
        card: '群名片展示名',
        role: 'admin',
        title: `头衔 token=${credential}`,
        joinTime: 1615555000,
        lastSentTime: 1792560000,
        level: '92',
        sex: 'female',
        age: 73,
        qage: 81,
        isRobot: false,
      }),
      fetchedAt: now,
    }]);

    const blocks = buildImpressionsPromptBlocks(repository, {
      session,
      sessionId: key,
      senderId: userId,
      senderName: String(userId),
      now,
      template: promptTemplateStore.get().replySystem,
    });
    assert.ok(blocks.memberTags);
    assert.match(blocks.memberTags, /群名片展示名（bot）/u);
    assert.match(blocks.memberTags, /管理员/u);
    assert.match(blocks.memberTags, /群名片展示名/u);
    assert.match(blocks.memberTags, /头衔/u);
    assert.match(blocks.memberTags, /\[敏感内容已隐藏\]/u);
    assert.doesNotMatch(blocks.memberTags, /(?:female|73|81|92|1615555000|1792560000)/u);
    assert.equal(blocks.memberTags.includes(credential), false);
  } finally {
    database.close();
  }
});

test('memberTags 双向注入未锁定关系并排除锁定关系', () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database, () => new Date(now));
    const key = sessionId(session);
    const siblingId = userId + 1;
    const lockedId = userId + 2;
    for (const [id, name] of [[userId, '小明'], [siblingId, '群友D'], [lockedId, '不注入的人']] as const) {
      repository.saveMessage({
        sessionId: key,
        messageId: `identity-${id}`,
        senderId: id,
        senderName: name,
        isSelf: false,
        plainText: '测试消息',
        segments: [{ type: 'text', text: '测试消息' }],
        time: now,
      });
    }
    repository.createRelation({
      account,
      aUserId: userId,
      bUserId: siblingId,
      type: 'brother',
      label: null,
      locked: false,
      createdAt: now,
    });
    const locked = repository.createRelation({
      account,
      aUserId: userId,
      bUserId: lockedId,
      type: 'lover',
      label: null,
      locked: false,
      createdAt: now,
    });
    repository.updateRelationLock(account, locked.id, true);

    const memberBlocks = buildImpressionsPromptBlocks(repository, {
      session,
      sessionId: key,
      senderId: userId,
      senderName: '小明',
      now,
      template: promptTemplateStore.get().replySystem,
    });
    const siblingBlocks = buildImpressionsPromptBlocks(repository, {
      session,
      sessionId: key,
      senderId: siblingId,
      senderName: '群友D',
      now,
      template: promptTemplateStore.get().replySystem,
    });

    assert.match(memberBlocks.memberTags ?? '', /和"群友D"是兄弟/u);
    assert.doesNotMatch(memberBlocks.memberTags ?? '', /不注入的人/u);
    assert.match(siblingBlocks.memberTags ?? '', /和"小明"是兄弟/u);
  } finally {
    database.close();
  }
});

test('关系提示行有数量与字符上限', () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database, () => new Date(now));
    const key = sessionId(session);
    for (let index = 0; index < 12; index += 1) {
      repository.createRelation({
        account,
        aUserId: userId,
        bUserId: userId + index + 1,
        type: 'brother',
        label: null,
        locked: false,
        createdAt: now,
      });
    }

    const lines = relationPromptLines(repository, account, key, userId);
    assert.equal(lines.length, 5);
    assert.ok(Array.from(lines.join('')).length <= 180);
  } finally {
    database.close();
  }
});
