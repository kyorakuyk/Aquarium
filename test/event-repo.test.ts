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
  getGroupEvent(account: number, id: number): (GroupEventInput & { id: number }) | undefined;
  listGroupEvents(account: number, sourceGroupId: number, since: number, limit: number): Array<
    GroupEventInput & { id: number }
  >;
  listRecentGroupEventGroupIds(account: number, since: number): number[];
}

interface GroupEventNoteInput {
  account: number;
  eventId: number;
  ownerId: number;
  sourceSessionId: string;
  text: string;
  intent: 'confide' | 'clarify' | 'advocate';
  level: 'L0' | 'L1' | 'L2';
  status: 'active' | 'retracted';
  sourceMessageIds: string[];
  createdAt: number;
  updatedAt: number;
}

interface GroupEventNoteRepository {
  upsertGroupEventNote(note: GroupEventNoteInput): number;
  listGroupEventNotesForOwner(account: number, ownerId: number): Array<GroupEventNoteInput & { id: number }>;
  listGroupEventNotesForEvent(account: number, eventId: number, status?: 'active' | 'retracted'):
    Array<GroupEventNoteInput & { id: number }>;
  updateGroupEventNote(account: number, id: number, update: Omit<GroupEventNoteInput, 'account' | 'eventId' | 'ownerId' | 'createdAt'>):
    GroupEventNoteInput & { id: number } | undefined;
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
    assert.equal(events.getGroupEvent(7, firstId)?.summary, '群友后来补充了漫展集合时间');
    assert.equal(events.getGroupEvent(8, firstId), undefined);
    assert.deepEqual(events.listRecentGroupEventGroupIds(7, 10), [80, 81]);
    assert.deepEqual(events.listRecentGroupEventGroupIds(7, 20), [80]);
    assert.deepEqual(events.listRecentGroupEventGroupIds(8, 10), [80]);
  });
});

test('event notes upsert per owner and preserve intent, source, and retraction state', async () => {
  await withRepository(async (repository) => {
    const events = repository as unknown as GroupEventRepository & GroupEventNoteRepository;
    const eventId = events.upsertGroupEvent(event({ account: 7, sourceGroupId: 80 }));
    const input: GroupEventNoteInput = {
      account: 7,
      eventId,
      ownerId: 42,
      sourceSessionId: '7:private:42',
      text: '对方解释了那次安排',
      intent: 'clarify',
      level: 'L1',
      status: 'active',
      sourceMessageIds: ['p-1'],
      createdAt: 30,
      updatedAt: 30,
    };

    const firstId = events.upsertGroupEventNote(input);
    const secondId = events.upsertGroupEventNote({
      ...input,
      text: '对方请求澄清那次安排',
      intent: 'advocate',
      level: 'L2',
      sourceMessageIds: ['p-1', 'p-2'],
      updatedAt: 40,
    });
    assert.equal(secondId, firstId);
    assert.deepEqual(events.listGroupEventNotesForEvent(7, eventId, 'active').map(({ id, intent, level }) => ({ id, intent, level })), [
      { id: firstId, intent: 'advocate', level: 'L2' },
    ]);
    assert.deepEqual(events.listGroupEventNotesForOwner(8, 42), []);

    const retracted = events.updateGroupEventNote(7, firstId, {
      sourceSessionId: '7:private:42',
      text: '对方请求澄清那次安排',
      intent: 'confide',
      level: 'L0',
      status: 'retracted',
      sourceMessageIds: ['p-1', 'p-2', 'p-3'],
      updatedAt: 50,
    });
    assert.equal(retracted?.status, 'retracted');
    assert.deepEqual(events.listGroupEventNotesForEvent(7, eventId, 'active'), []);
    assert.deepEqual(events.listGroupEventNotesForOwner(7, 42).map(({ id, intent, level, status }) => ({
      id, intent, level, status,
    })), [{ id: firstId, intent: 'confide', level: 'L0', status: 'retracted' }]);
  });
});
