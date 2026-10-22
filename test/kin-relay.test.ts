import assert from 'node:assert/strict';
import test from 'node:test';
import { syncKinRelays } from '../src/core/privacy/kin-relay.ts';
import { buildImpressionsPromptBlocks } from '../src/core/impressions/prompt-blocks.ts';
import { tagActivation } from '../src/core/impressions/tags.ts';
import { persistTagPromptStates } from '../src/core/impressions/prompt-state.ts';
import { promptTemplateStore } from '../src/core/prompt/templates.ts';
import { sessionId, type SessionKey } from '../src/core/shared/events.ts';
import { openDatabase } from '../src/store/db.ts';
import { createRepository } from '../src/store/repository.ts';
import type { NewPrivateFactRecord } from '../src/store/privacy-repo.ts';

const at = Date.UTC(2026, 9, 21, 12);

function privateFact(account: number, level: NewPrivateFactRecord['level'], text: string, at: number): NewPrivateFactRecord {
  const ownerId = account + 1000;
  return {
    account,
    ownerId,
    sessionId: `${account}:private:${ownerId}`,
    text,
    keywords: ['喜欢', '猫咪'],
    level,
    levelSource: 'manual',
    mentions: 0,
    mentionEvidence: [],
    evidence: [{ messageId: `message-${account}`, time: at, quote: '' }],
    status: 'active',
    createdAt: at,
    updatedAt: at,
  };
}

test('kin relays exclude L0, share only with group members, start below threshold, and are idempotent', () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    const sourceAccount = 1001;
    const recipientAccount = 1002;
    const unrelatedAccount = 1003;
    const groupId = repository.createKinGroup('共同测试');
    repository.setKinGroupMembers(groupId, [sourceAccount, recipientAccount]);
    repository.insertPrivateFact(privateFact(sourceAccount, 'L0', '主人级别零内容', at));
    const l1Id = repository.insertPrivateFact(privateFact(sourceAccount, 'L1', '主人级别一内容', at));
    const l2Id = repository.insertPrivateFact(privateFact(sourceAccount, 'L2', '主人级别二内容', at));

    syncKinRelays(repository, at);
    const relays = repository.listRelayTagsForAccount(recipientAccount);
    assert.deepEqual(relays.map((tag) => tag.sourceFactId), [l1Id, l2Id]);
    assert.equal(relays.every((tag) => tag.sourceAccount === sourceAccount), true);
    assert.equal(relays.every((tag) => tag.sessionId === `kin:${recipientAccount}`), true);
    assert.equal(relays.every((tag) => tagActivation(tag, at) < 0.5), true);
    assert.deepEqual(repository.listRelayTagsForAccount(unrelatedAccount), []);

    syncKinRelays(repository, at + 1);
    assert.equal(repository.listRelayTagsForAccount(recipientAccount).length, 2);

    repository.setKinGroupMembers(groupId, [sourceAccount]);
    syncKinRelays(repository, at + 2, [recipientAccount]);
    assert.deepEqual(repository.listRelayTagsForAccount(recipientAccount), []);
  } finally {
    database.close();
  }
});

test('group prompts can read only kin members’ group-sourced fact tags', () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    const recipientAccount = 1102;
    const senderId = 2102;
    const session: SessionKey = { account: recipientAccount, kind: 'group', peer: 3102 };
    const targetSessionId = sessionId(session);
    const kinGroupId = repository.createKinGroup('共享事实');
    repository.setKinGroupMembers(kinGroupId, [1101, recipientAccount]);
    repository.setAccountKind(recipientAccount, senderId, 'bot', at);
    const sources: Array<{ account: number; text: string }> = [
      { account: 1101, text: '眷属群聊事实' },
      { account: 1103, text: '非眷属群聊事实' },
    ];
    for (const source of sources) {
      const sourceSessionId = `${source.account}:group:${source.account + 100}`;
      repository.insertTag({
        account: source.account,
        sessionId: sourceSessionId,
        userId: null,
        text: source.text,
        norm: source.text,
        category: 'positioning',
        kind: 'fact',
        subject: null,
        polarity: null,
        origin: 'inferred',
        locked: false,
        status: 'confirmed',
        source: 'auto',
        samples: 1,
        evidence: [],
        firstSeen: at,
        lastSeen: at,
        supersededBy: null,
        updatedAt: at,
      });
    }

    const blocks = buildImpressionsPromptBlocks(repository, {
      session,
      sessionId: targetSessionId,
      senderId,
      senderName: '眷属机器人',
      now: at,
      template: promptTemplateStore.get().replySystem,
    });
    assert.match(blocks.groupTags ?? '', /眷属群聊事实/u);
    assert.doesNotMatch(blocks.groupTags ?? '', /非眷属群聊事实/u);
  } finally {
    database.close();
  }
});

test('group prompt renders relayed source and redacts credential-like private text', () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    const sourceAccount = 1201;
    const recipientAccount = 1202;
    const senderId = 2202;
    const session: SessionKey = { account: recipientAccount, kind: 'group', peer: 3202 };
    const targetSessionId = sessionId(session);
    const groupId = repository.createKinGroup('转述提示词');
    repository.setKinGroupMembers(groupId, [sourceAccount, recipientAccount]);
    repository.setAccountKind(recipientAccount, senderId, 'bot', at);
    const secretText = 'api_key=abcDEF1234567';
    const factId = repository.insertPrivateFact(privateFact(sourceAccount, 'L1', secretText, at));
    syncKinRelays(repository, at);
    repository.updatePrivateFact(factId, {
      text: secretText,
      keywords: ['api_key', '访问密钥'],
      evidence: [{ messageId: 'later-message', time: at + 1, quote: secretText }],
      updatedAt: at + 1,
    });
    syncKinRelays(repository, at + 1);

    const blocks = buildImpressionsPromptBlocks(repository, {
      session,
      sessionId: targetSessionId,
      senderId,
      senderName: '转述接收人格',
      now: at + 1,
      template: promptTemplateStore.get().replySystem,
    });
    const prompt = blocks.groupTags ?? '';
    assert.match(prompt, /听账号 1201 转述/u);
    assert.match(prompt, /\[敏感内容已隐藏\]/u);
    assert.doesNotMatch(prompt, /api_key=abcDEF1234567/u);
  } finally {
    database.close();
  }
});

test('shared group fact prompt hysteresis is isolated per recipient session', () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    const sourceAccount = 1301;
    const recipientAccount = 1302;
    const groupId = repository.createKinGroup('独立迟滞');
    repository.setKinGroupMembers(groupId, [sourceAccount, recipientAccount]);
    repository.setAccountKind(recipientAccount, 2302, 'bot', at);
    const text = '低置信群聊事实';
    repository.insertTag({
      account: sourceAccount,
      sessionId: `${sourceAccount}:group:3301`,
      userId: null,
      text,
      norm: text,
      category: 'recent',
      kind: 'fact',
      subject: null,
      polarity: null,
      origin: 'inferred',
      locked: false,
      status: 'confirmed',
      source: 'auto',
      samples: 2,
      evidence: [],
      firstSeen: at,
      lastSeen: at,
      supersededBy: null,
      updatedAt: at,
    });
    const build = (peer: number, now: number) => {
      const session: SessionKey = { account: recipientAccount, kind: 'group', peer };
      return buildImpressionsPromptBlocks(repository, {
        session,
        sessionId: sessionId(session),
        senderId: 2302,
        senderName: '人格',
        now,
        template: promptTemplateStore.get().replySystem,
      }, (updates) => persistTagPromptStates(repository, updates)).groupTags ?? '';
    };

    assert.match(build(3302, at), /低置信群聊事实/u);
    const later = at + 4 * 24 * 60 * 60 * 1000;
    assert.match(build(3302, later), /低置信群聊事实/u);
    assert.doesNotMatch(build(3303, later), /低置信群聊事实/u);
  } finally {
    database.close();
  }
});

test('referred fact prompt hysteresis is isolated per recipient session', () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    const sourceAccount = 1401;
    const recipientAccount = 1402;
    const senderId = 2402;
    const groupId = repository.createKinGroup('转述迟滞');
    repository.setKinGroupMembers(groupId, [sourceAccount, recipientAccount]);
    repository.setAccountKind(recipientAccount, senderId, 'bot', at);
    const text = '眷属私聊转述事实';
    const factId = repository.insertPrivateFact(privateFact(sourceAccount, 'L1', text, at));
    syncKinRelays(repository, at);
    repository.updatePrivateFact(factId, {
      text,
      keywords: ['眷属', '私聊事实'],
      evidence: [{ messageId: 'independent-message', time: at + 1, quote: '' }],
      updatedAt: at + 1,
    });
    syncKinRelays(repository, at + 1);
    const build = (peer: number, now: number) => {
      const session: SessionKey = { account: recipientAccount, kind: 'group', peer };
      return buildImpressionsPromptBlocks(repository, {
        session,
        sessionId: sessionId(session),
        senderId,
        senderName: '人格',
        now,
        template: promptTemplateStore.get().replySystem,
      }, (updates) => persistTagPromptStates(repository, updates)).groupTags ?? '';
    };

    assert.match(build(3402, at + 1), /眷属私聊转述事实/u);
    const later = at + 1 + 4 * 24 * 60 * 60 * 1000;
    assert.match(build(3402, later), /眷属私聊转述事实/u);
    assert.doesNotMatch(build(3403, later), /眷属私聊转述事实/u);
  } finally {
    database.close();
  }
});
