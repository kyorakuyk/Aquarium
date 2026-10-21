import assert from 'node:assert/strict';
import test from 'node:test';
import type { QqProfileActions } from '../src/adapters/types.ts';
import { sessionId } from '../src/core/shared/events.ts';
import { createQqProfileService } from '../src/core/profiles/qq-profile-service.ts';
import { openDatabase } from '../src/store/db.ts';
import { createRepository } from '../src/store/repository.ts';

const account = 10001;
const groupId = 123456;
const nowAt = Date.UTC(2026, 0, 1);
const DAY_MS = 24 * 60 * 60_000;

function createAdapter(calls: Map<string, number>): QqProfileActions {
  const count = (action: string) => calls.set(action, (calls.get(action) ?? 0) + 1);
  return {
    async getGroupInfo() {
      count('group');
      return {
        groupName: '测试群', memberCount: 2, maxMemberCount: 200,
        groupCreateTime: Date.UTC(2021, 0, 1) / 1_000,
        groupLevel: 4, groupDescription: '佛系开黑',
      };
    },
    async getGroupMembers() {
      count('members');
      return [
        {
          userId: 42, nickname: '测试群友', card: '群名片', role: 'admin', title: '测试头衔',
          joinTime: Date.UTC(2022, 0, 1) / 1_000, lastSentTime: nowAt / 1_000,
          level: '42', sex: 'female', age: 23, isRobot: false,
        },
        {
          userId: 43, nickname: '热心群友', role: 'member',
          joinTime: Date.UTC(2025, 0, 1) / 1_000, sex: 'male', age: 31, isRobot: false,
        },
      ];
    },
    async getGroupHonors() {
      count('honors');
      return [{ kind: 'dragon_king', userId: 42, nickname: '测试群友' }];
    },
    async getStrangerInfo(userId) {
      count(`stranger:${userId}`);
      return userId === 42
        ? { longNick: '喜欢游戏，INTJ', regTime: Date.UTC(2021, 0, 1) / 1_000 }
        : { longNick: '', qage: 3 };
    },
    async getGroupNoticeLatest() {
      count('notice');
      return '最新公告';
    },
    async getEssenceCount() {
      count('essence');
      return 12;
    },
  };
}

test('group profile refresh stores allowlisted QQ data and reuses it for 24 hours', async () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    let now = nowAt;
    const service = createQqProfileService({ repository, now: () => now });
    const calls = new Map<string, number>();
    const adapter = createAdapter(calls);

    const first = await service.readGroup({ account, groupId, adapter });
    assert.equal(first.profile.groupInfo?.groupName, '测试群');
    assert.equal(first.profile.essenceCount, 12);
    assert.equal(first.profile.latestNotice, '最新公告');
    assert.equal(first.membersAvailable, true);
    assert.equal(first.members.length, 2);
    assert.equal(first.members[0]?.qage, 5);
    assert.equal(first.members[0]?.longNick, '喜欢游戏，INTJ');
    assert.deepEqual([...calls.values()], [1, 1, 1, 1, 1, 1, 1]);

    const reopenedService = createQqProfileService({ repository, now: () => now });
    const cached = await reopenedService.readGroup({ account, groupId, adapter });
    assert.equal(cached.fetchedAt, nowAt);
    assert.deepEqual([...calls.values()], [1, 1, 1, 1, 1, 1, 1]);

    now += DAY_MS;
    await service.readGroup({ account, groupId, adapter });
    assert.deepEqual([...calls.values()], [2, 2, 2, 2, 2, 2, 2]);
    await service.readGroup({ account, groupId, adapter, force: true });
    assert.deepEqual([...calls.values()], [3, 3, 3, 3, 3, 3, 3]);
  } finally {
    database.close();
  }
});

test('profile action failures become unavailable fields without retrying or logging', async () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    const calls = new Map<string, number>();
    const valid = createAdapter(calls);
    const adapter: QqProfileActions = {
      ...valid,
      async getGroupInfo() {
        calls.set('failedGroup', (calls.get('failedGroup') ?? 0) + 1);
        throw new Error('fixture action failure');
      },
      async getGroupMembers() {
        calls.set('failedMembers', (calls.get('failedMembers') ?? 0) + 1);
        throw new Error('fixture action failure');
      },
    };
    const service = createQqProfileService({ repository, now: () => nowAt });

    const result = await service.readGroup({ account, groupId, adapter });
    assert.equal(result.profile.groupInfo, null);
    assert.equal(result.membersAvailable, false);
    assert.deepEqual(result.members, []);
    assert.equal(calls.get('failedGroup'), 1);
    assert.equal(calls.get('failedMembers'), 1);
    assert.equal(calls.get('honors'), 1);
    assert.equal(calls.get('notice'), 1);
    assert.equal(calls.get('essence'), 1);
  } finally {
    database.close();
  }
});

test('signature MBTI creates and updates a confirmed self-report tag, respects vetoes, and deletes on removal', async () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    const calls = new Map<string, number>();
    const base = createAdapter(calls);
    let signature = 'AINTJX';
    const adapter: QqProfileActions = {
      ...base,
      async getStrangerInfo(userId) {
        calls.set(`signature:${userId}`, (calls.get(`signature:${userId}`) ?? 0) + 1);
        return { longNick: userId === 42 ? signature : '' };
      },
    };
    const service = createQqProfileService({ repository, now: () => nowAt });
    const sessionKey = sessionId({ account, kind: 'group', peer: groupId });
    const tags = () => repository.listTagsForSubject(account, sessionKey, 42);

    await service.readGroup({ account, groupId, adapter });
    assert.deepEqual(tags(), []);

    signature = 'I prefer intj.';
    await service.readGroup({ account, groupId, adapter, force: true });
    let tag = tags()[0];
    assert.equal(tag?.text, 'INTJ');
    assert.equal(tag?.origin, 'self_report');
    assert.equal(tag?.status, 'confirmed');
    assert.equal(tag?.samples, 1);
    assert.deepEqual(tag?.evidence, [{ kind: 'signature', text: signature, fetchedAt: nowAt }]);
    const tagId = tag?.id;
    assert.ok(tagId);

    signature = 'I now identify as ENFP';
    await service.readGroup({ account, groupId, adapter, force: true });
    tag = tags()[0];
    assert.equal(tag?.id, tagId);
    assert.equal(tag?.text, 'ENFP');
    assert.equal(tag?.status, 'confirmed');
    assert.equal(tag?.samples, 1);

    assert.equal(repository.deleteTagAndCreateVeto(tagId), true);
    await service.readGroup({ account, groupId, adapter, force: true });
    assert.deepEqual(tags(), []);

    signature = 'INTJ';
    await service.readGroup({ account, groupId, adapter, force: true });
    assert.equal(tags()[0]?.text, 'INTJ');
    signature = 'no personality code';
    await service.readGroup({ account, groupId, adapter, force: true });
    assert.deepEqual(tags(), []);
  } finally {
    database.close();
  }
});
