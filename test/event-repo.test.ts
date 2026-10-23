import assert from 'node:assert/strict';
import test from 'node:test';
import { withRepository } from './pipeline-test-helpers.ts';

interface GroupEventInput {
  account: number;
  sourceGroupId: number;
  anchorMessageId: string;
  title: string;
  summary: string;
  participantIds: number[];
  evidenceMessageIds: string[];
  occurredAt: number;
  createdAt: number;
  updatedAt: number;
}

interface GroupEventRepository {
  upsertGroupEvent(event: GroupEventInput): number;
  listGroupEvents(account: number, sourceGroupId: number, since: number, limit: number): Array<
    GroupEventInput & { id: number }
  >;
}

function event(overrides: Partial<GroupEventInput> = {}): GroupEventInput {
  return {
    account: 7,
    sourceGroupId: 80,
    anchorMessageId: 'm-1',
    title: '周末漫展',
    summary: '群友约好周末一同参加漫展',
    participantIds: [42, 43],
    evidenceMessageIds: ['m-1', 'm-2'],
    occurredAt: 10,
    createdAt: 20,
    updatedAt: 20,
    ...overrides,
  };
}

test('group events upsert idempotently and stay account/group scoped', async () => {
  await withRepository(async (repository) => {
    const events = repository as unknown as GroupEventRepository;
    assert.equal(typeof events.upsertGroupEvent, 'function');
    const firstId = events.upsertGroupEvent(event());
    const secondId = events.upsertGroupEvent(event({
      summary: '群友后来补充了漫展集合时间',
      evidenceMessageIds: ['m-1', 'm-2', 'm-3'],
      updatedAt: 30,
    }));
    const sameAnchorEventId = events.upsertGroupEvent(event({
      title: '另一个事件',
      summary: '同一条消息还提到另一件不同事件',
    }));
    const laterId = events.upsertGroupEvent(event({
      anchorMessageId: 'm-4',
      title: '桌游聚会',
      summary: '几位群友约好周五玩桌游',
      evidenceMessageIds: ['m-4'],
      occurredAt: 40,
      createdAt: 41,
      updatedAt: 41,
    }));
    events.upsertGroupEvent(event({ account: 8, anchorMessageId: 'm-1' }));
    events.upsertGroupEvent(event({ sourceGroupId: 81, anchorMessageId: 'm-1' }));

    assert.equal(secondId, firstId);
    assert.notEqual(sameAnchorEventId, firstId);
    assert.notEqual(laterId, firstId);
    assert.deepEqual(events.listGroupEvents(7, 80, 10, 10).map(({ id, summary }) => ({ id, summary })), [
      { id: laterId, summary: '几位群友约好周五玩桌游' },
      { id: sameAnchorEventId, summary: '同一条消息还提到另一件不同事件' },
      { id: firstId, summary: '群友后来补充了漫展集合时间' },
    ]);
    assert.equal(events.listGroupEvents(8, 80, 0, 10).length, 1);
    assert.equal(events.listGroupEvents(7, 81, 0, 10).length, 1);
    assert.equal(events.listGroupEvents(7, 80, 41, 10).length, 0);
  });
});
