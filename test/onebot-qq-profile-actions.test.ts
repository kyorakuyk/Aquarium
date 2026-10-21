import assert from 'node:assert/strict';
import test from 'node:test';
import { OneBotAdapter } from '../src/adapters/onebot/adapter.ts';
import {
  account,
  createFakeClient,
  createFixture,
} from './onebot-adapter-test-helpers.ts';

const groupId = 123456;

test('OneBot 资料动作只请求计划内字段并规范化结果', async (t) => {
  const root = createFixture(t, [{ host: '127.0.0.1', port: 3001 }]);
  const fake = createFakeClient();
  const adapter = new OneBotAdapter({ account, snowlumaDir: root }, () => fake.client);
  t.after(() => adapter.close());
  await adapter.connect();

  fake.state.rawResults.set('get_group_info', {
    group_id: groupId,
    group_name: '测试群',
    member_count: '17',
    max_member_count: 200,
    group_create_time: 1_614_000_000,
    group_level: 4,
    group_description: '佛系开黑',
    secret: 'must not persist',
  });
  fake.state.rawResults.set('get_group_member_list', [
    {
      user_id: '42', nickname: '测试群友', card: '龙王', role: 'owner', title: '测试头衔',
      join_time: 1_614_000_000, last_sent_time: 1_720_000_000, level: '42',
      sex: 'female', age: 23, is_robot: false,
    },
    { nickname: '缺少用户号的无效记录' },
  ]);
  fake.state.rawResults.set('get_group_honor_info', {
    current_talkative: { user_id: '42', nickname: '测试群友' },
    performer_list: [{ user_id: 43, nickname: '群友A' }],
    legend_list: [{ user_id: 44, nickname: '群友D' }],
    emotion_list: [{ user_id: 45, nickname: '热心群友' }],
    strong_newbie_list: [{ user_id: 46, nickname: '新朋友' }],
  });
  fake.state.rawResults.set('get_stranger_info', {
    user_id: 42, long_nick: '自述 INTJ', qage: 5, reg_time: 1_500_000_000,
  });
  fake.state.rawResults.set('_get_group_notice', [
    { publish_time: 100, message: { text: '旧公告' } },
    { publish_time: 200, message: { text: '最新公告' } },
  ]);
  fake.state.rawResults.set('get_essence_msg_list', [{}, {}, {}]);

  assert.deepEqual(await adapter.getGroupInfo(groupId), {
    groupName: '测试群',
    memberCount: 17,
    maxMemberCount: 200,
    groupCreateTime: 1_614_000_000,
    groupLevel: 4,
    groupDescription: '佛系开黑',
  });
  assert.deepEqual(await adapter.getGroupMembers(groupId), [{
    userId: 42,
    nickname: '测试群友',
    card: '龙王',
    role: 'owner',
    title: '测试头衔',
    joinTime: 1_614_000_000,
    lastSentTime: 1_720_000_000,
    level: '42',
    sex: 'female',
    age: 23,
    isRobot: false,
  }]);
  assert.deepEqual(await adapter.getGroupHonors(groupId), [
    { kind: 'dragon_king', userId: 42, nickname: '测试群友' },
    { kind: 'performer', userId: 43, nickname: '群友A' },
    { kind: 'legend', userId: 44, nickname: '群友D' },
    { kind: 'emotion', userId: 45, nickname: '热心群友' },
    { kind: 'strong_newbie', userId: 46, nickname: '新朋友' },
  ]);
  assert.deepEqual(await adapter.getStrangerInfo(42), {
    longNick: '自述 INTJ',
    qage: 5,
    regTime: 1_500_000_000,
  });
  assert.equal(await adapter.getGroupNoticeLatest(groupId), '最新公告');
  assert.equal(await adapter.getEssenceCount(groupId), 3);
  assert.deepEqual(fake.state.rawCalls, [
    ['get_group_info', { group_id: groupId }],
    ['get_group_member_list', { group_id: groupId }],
    ['get_group_honor_info', { group_id: groupId, type: 'all' }],
    ['get_stranger_info', { user_id: 42 }],
    ['_get_group_notice', { group_id: groupId }],
    ['get_essence_msg_list', { group_id: groupId }],
  ]);
});

test('OneBot 资料动作拒绝无效输入与响应，并且调用失败时不重试', async (t) => {
  const root = createFixture(t, [{ host: '127.0.0.1', port: 3001 }]);
  const fake = createFakeClient();
  const adapter = new OneBotAdapter({ account, snowlumaDir: root }, () => fake.client);
  t.after(() => adapter.close());
  await adapter.connect();

  await assert.rejects(adapter.getGroupInfo(0), RangeError);
  assert.equal(fake.state.rawCalls.length, 0);
  fake.state.rawResults.set('get_group_info', null);
  fake.state.rawResults.set('get_group_member_list', { members: [] });
  assert.equal(await adapter.getGroupInfo(groupId), undefined);
  assert.equal(await adapter.getGroupMembers(groupId), undefined);

  const callsBeforeFailure = fake.state.rawCalls.length;
  fake.client.raw = async (...args: unknown[]) => {
    fake.state.rawCalls.push(args);
    throw new Error('fixture failure');
  };
  await assert.rejects(adapter.getGroupInfo(groupId), /fixture failure/u);
  assert.equal(fake.state.rawCalls.length, callsBeforeFailure + 1);
  assert.deepEqual(fake.state.rawCalls.at(-1), ['get_group_info', { group_id: groupId }]);
});
