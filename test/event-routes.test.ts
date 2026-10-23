import assert from 'node:assert/strict';
import test from 'node:test';
import { account, authHeaders, groupSession, now, withPanel } from './panel-test-helpers.ts';

function jsonHeaders(): HeadersInit {
  return { ...authHeaders(), 'Content-Type': 'application/json' };
}

test('event book reads annotations and manually changes intent/level with state readback', async () => {
  await withPanel(async ({ app, repository }) => {
    const eventId = repository.upsertGroupEvent({
      account,
      sourceGroupId: groupSession.peer,
      anchorMessageId: 'panel-event',
      title: '周末漫展',
      summary: '群友约好周末参加漫展',
      participantIds: [42],
      evidenceMessageIds: ['panel-event'],
      occurredAt: now - 60_000,
      createdAt: now - 60_000,
      updatedAt: now - 60_000,
    });
    const noteId = repository.upsertGroupEventNote({
      account,
      eventId,
      ownerId: 42,
      sourceSessionId: `${account}:private:42`,
      text: '集合时间改成周日下午三点',
      intent: 'clarify',
      level: 'L1',
      status: 'active',
      sourceMessageIds: ['private-event-note'],
      createdAt: now - 30_000,
      updatedAt: now - 30_000,
    });
    const listEndpoint = `/api/events?account=${account}`;
    const listed = await app.request(listEndpoint, { headers: authHeaders() });
    assert.equal(listed.status, 200);
    const listedBody = await listed.json() as {
      events: Array<{ id: number; notes: Array<{ id: number; intent: string; level: string }> }>;
    };
    assert.equal(listedBody.events[0]?.id, eventId);
    assert.deepEqual(
      listedBody.events[0]?.notes.map(({ id, intent, level }) => ({ id, intent, level })),
      [{ id: noteId, intent: 'clarify', level: 'L1' }],
    );

    const noteEndpoint = `/api/events/${eventId}/notes/${noteId}?account=${account}`;
    const invalid = await app.request(noteEndpoint, {
      method: 'PATCH',
      headers: jsonHeaders(),
      body: JSON.stringify({ level: 'L3' }),
    });
    assert.equal(invalid.status, 400);

    const advocate = await app.request(noteEndpoint, {
      method: 'PATCH',
      headers: jsonHeaders(),
      body: JSON.stringify({ intent: 'advocate', level: 'L2' }),
    });
    assert.equal(advocate.status, 200);
    const advocateBody = await advocate.json() as { note: { intent: string; level: string; status: string } };
    assert.deepEqual({
      intent: advocateBody.note.intent,
      level: advocateBody.note.level,
      status: advocateBody.note.status,
    }, { intent: 'advocate', level: 'L2', status: 'active' });
    assert.equal(repository.eventAdvocacyByEvent(account, eventId)?.status, 'awaiting_confirmation');

    const confide = await app.request(noteEndpoint, {
      method: 'PATCH',
      headers: jsonHeaders(),
      body: JSON.stringify({ intent: 'confide' }),
    });
    assert.equal(confide.status, 200);
    const confideBody = await confide.json() as { note: { intent: string; level: string; status: string } };
    assert.deepEqual({
      intent: confideBody.note.intent,
      level: confideBody.note.level,
      status: confideBody.note.status,
    }, { intent: 'confide', level: 'L0', status: 'retracted' });
    assert.equal(repository.eventAdvocacyByEvent(account, eventId)?.status, 'cancelled');
  });
});
