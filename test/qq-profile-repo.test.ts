import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../src/store/db.ts';
import { createRepository } from '../src/store/repository.ts';

test('QQ profile caches persist by account and group, and roster replacement removes stale members', () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    assert.equal(repository.getQqGroupProfile(10001, 123), undefined);
    assert.equal(repository.getQqMemberProfile(10001, 123, 42), undefined);

    repository.saveQqGroupProfile({
      account: 10001,
      groupId: 123,
      json: JSON.stringify({ groupName: '测试群' }),
      fetchedAt: 100,
    });
    repository.replaceQqMemberProfiles(10001, 123, [
      { account: 10001, groupId: 123, userId: 42, json: JSON.stringify({ card: '群名片' }), fetchedAt: 100 },
      { account: 10001, groupId: 123, userId: 43, json: JSON.stringify({ role: 'admin' }), fetchedAt: 100 },
    ]);
    repository.replaceQqMemberProfiles(10001, 124, [
      { account: 10001, groupId: 124, userId: 42, json: JSON.stringify({ card: '另一群' }), fetchedAt: 101 },
    ]);

    assert.deepEqual(repository.getQqGroupProfile(10001, 123), {
      account: 10001,
      groupId: 123,
      json: '{"groupName":"测试群"}',
      fetchedAt: 100,
    });
    assert.deepEqual(repository.getQqMemberProfile(10001, 123, 42), {
      account: 10001,
      groupId: 123,
      userId: 42,
      json: '{"card":"群名片"}',
      fetchedAt: 100,
    });
    assert.equal(repository.getQqMemberProfile(10001, 124, 42)?.json, '{"card":"另一群"}');

    repository.replaceQqMemberProfiles(10001, 123, [
      { account: 10001, groupId: 123, userId: 42, json: JSON.stringify({ card: '新名片' }), fetchedAt: 200 },
    ]);
    assert.deepEqual(repository.listQqMemberProfiles(10001, 123).map(({ userId }) => userId), [42]);
    assert.equal(repository.getQqMemberProfile(10001, 123, 43), undefined);
    assert.equal(repository.getQqMemberProfile(10001, 124, 42)?.json, '{"card":"另一群"}');

    repository.replaceQqMemberProfiles(10001, 123, []);
    assert.deepEqual(repository.listQqMemberProfiles(10001, 123), []);
  } finally {
    database.close();
  }
});
