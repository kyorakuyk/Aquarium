import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionId, type SessionKey } from '../src/core/shared/events.ts';
import { openDatabase } from '../src/store/db.ts';
import { createRepository } from '../src/store/repository.ts';

const session: SessionKey = { account: 12001, kind: 'group', peer: 12002 };
const groupSessionId = sessionId(session);

function tag(input: {
  account: number;
  userId: number;
  text: string;
  samples: number;
  evidence: Array<{ messageId: string; time: number; quote: string }>;
  source?: 'auto' | 'manual';
  origin?: 'inferred' | 'self_report' | 'manual';
  locked?: boolean;
}) {
  return {
    account: input.account,
    sessionId: groupSessionId,
    userId: input.userId,
    text: input.text,
    norm: input.text,
    category: 'personality' as const,
    subject: null,
    polarity: null,
    origin: input.origin ?? 'inferred',
    locked: input.locked ?? false,
    status: 'confirmed' as const,
    source: input.source ?? 'auto',
    samples: input.samples,
    evidence: input.evidence,
    firstSeen: 10,
    lastSeen: 20,
    supersededBy: null,
    updatedAt: 20,
  };
}

test('v19 identity tables remain available in schema v20', () => {
  const database = openDatabase(':memory:');
  try {
    const version = database.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number };
    const kinds = database.prepare("PRAGMA table_info('account_kinds')").all() as Array<{ name: string }>;
    const relations = database.prepare("PRAGMA table_info('relations')").all() as Array<{ name: string }>;
    assert.equal(version.version, 20);
    assert.deepEqual(kinds.map(({ name }) => name), ['account', 'user_id', 'kind', 'created_at']);
    assert.deepEqual(relations.map(({ name }) => name), [
      'id', 'account', 'a_user_id', 'b_user_id', 'type', 'label', 'locked', 'created_at',
    ]);
  } finally {
    database.close();
  }
});

test('account kinds are scoped manually and non-alt relations are visible from both sides', () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    repository.setAccountKind(session.account, 42, 'bot', 100);
    assert.equal(repository.getAccountKind(session.account, 42)?.kind, 'bot');
    assert.equal(repository.getAccountKind(session.account + 1, 42), undefined);

    const relation = repository.createRelation({
      account: session.account,
      aUserId: 42,
      bUserId: 43,
      type: 'brother',
      label: null,
      locked: false,
      createdAt: 101,
    });
    assert.equal(relation.aUserId, 42);
    assert.equal(relation.bUserId, 43);
    assert.deepEqual(repository.listRelationsForUser(session.account, 42), [relation]);
    assert.deepEqual(repository.listRelationsForUser(session.account, 43), [relation]);
    assert.equal(repository.mainUserIdFor(session.account, 43), 43);
    assert.equal(repository.updateRelationLock(session.account, relation.id, true), true);
    assert.equal(repository.listRelationsForUser(session.account, 43)[0]?.locked, true);
  } finally {
    database.close();
  }
});

test('linking an alt does not overwrite a manually assigned bot kind', () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    repository.setAccountKind(session.account, 43, 'bot', 100);
    repository.linkAltAccount({ account: session.account, aUserId: 42, bUserId: 43, createdAt: 101 });
    assert.equal(repository.getAccountKind(session.account, 43)?.kind, 'bot');
  } finally {
    database.close();
  }
});

test('linking an alt merges tags with message-id deduplication; unlinking does not split them back', () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    const mainTagId = repository.insertTag(tag({
      account: session.account,
      userId: 42,
      text: '耐心',
      samples: 1,
      evidence: [{ messageId: 'shared', time: 10, quote: '主号证据' }],
    }));
    const altTagId = repository.insertTag(tag({
      account: session.account,
      userId: 43,
      text: '耐心',
      samples: 2,
      evidence: [
        { messageId: 'shared', time: 11, quote: '重复证据' },
        { messageId: 'alt-only', time: 20, quote: '小号证据' },
      ],
      source: 'manual',
      origin: 'manual',
      locked: true,
    }));

    const relation = repository.linkAltAccount({
      account: session.account,
      aUserId: 42,
      bUserId: 43,
      createdAt: 30,
    });
    const merged = repository.tagById(mainTagId);
    const superseded = repository.tagById(altTagId);
    assert.equal(repository.mainUserIdFor(session.account, 43), 42);
    assert.equal(repository.getAccountKind(session.account, 43)?.kind, 'alt');
    assert.equal(merged?.samples, 2);
    assert.deepEqual(merged?.evidence.map(({ messageId }) => messageId), ['shared', 'alt-only']);
    assert.equal(merged?.locked, true);
    assert.equal(merged?.source, 'manual');
    assert.equal(superseded?.status, 'superseded');
    assert.equal(superseded?.supersededBy, mainTagId);

    assert.equal(repository.deleteRelation(session.account, relation.id), true);
    assert.equal(repository.mainUserIdFor(session.account, 43), 43);
    assert.equal(repository.tagById(mainTagId)?.userId, 42);
    assert.equal(repository.tagById(altTagId)?.status, 'superseded');
  } finally {
    database.close();
  }
});
