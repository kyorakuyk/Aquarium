import assert from 'node:assert/strict';
import test from 'node:test';
import { createEventAdvocacyScheduler } from '../src/app/event-advocacy-scheduler.ts';

 test('scheduler routes confirmed advocacy through the source group session queue', async () => {
  const sentEventIds: number[] = [];
  const queueKeys: string[] = [];
  const repository = {
    listConfirmedEventAdvocacies: (account: number) => account === 7
      ? [{ account: 7, eventId: 11 }, { account: 7, eventId: 12 }]
      : [],
    getGroupEvent: (_account: number, eventId: number) => eventId === 11
      ? { id: 11, account: 7, sourceGroupId: 101 }
      : eventId === 12 ? { id: 12, account: 7, sourceGroupId: 102 } : undefined,
  };
  const scheduler = createEventAdvocacyScheduler({
    getConfig: () => ({ accounts: [{ uin: 7 }] }),
    repository,
    getPipeline: () => ({ sendEventAdvocacy: async (eventId: number) => {
      sentEventIds.push(eventId);
      return 'sent';
    } }),
    enqueue: async (key: string, task: () => Promise<unknown>) => {
      queueKeys.push(key);
      return task();
    },
  });

  await scheduler.tick();

  assert.deepEqual(queueKeys, ['7:group:101', '7:group:102']);
  assert.deepEqual(sentEventIds, [11, 12]);
  scheduler.close();
});
