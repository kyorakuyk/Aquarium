import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/store/db.ts';
import { migrations } from '../src/store/migrations/index.ts';
import { createRepository } from '../src/store/repository.ts';
import {
  buildEventAdvocacyConfirmationRequest,
  markEventAdvocacyConfirmationPrompt,
  processEventAdvocacyConfirmationMessage,
} from '../src/core/privacy/event-advocacy.ts';

interface EventAdvocacyRepository {
  ensureEventAdvocacyPending(input: {
    account: number;
    eventId: number;
    ownerId: number;
    sourceSessionId: string;
    requestedAt: number;
  }): { status: string; ownerId: number } | undefined;
  eventAdvocacyByEvent(account: number, eventId: number): {
    status: string;
    sentMessageId?: string;
  } | undefined;
  markEventAdvocacyPrompted(input: {
    account: number;
    eventId: number;
    ownerId: number;
    promptMessageId: string;
    promptedAt: number;
  }): boolean;
  confirmEventAdvocacy(input: {
    account: number;
    eventId: number;
    ownerId: number;
    promptMessageId: string;
    confirmationMessageId: string;
    confirmedAt: number;
  }): boolean;
  claimEventAdvocacy(account: number, eventId: number, claimedAt: number): boolean;
  finishEventAdvocacy(input: {
    account: number;
    eventId: number;
    status: 'sent';
    sentMessageId: string;
    sentAt: number;
    updatedAt: number;
  }): boolean;
}

test('current schema stores one-time event advocacy state', () => {
  const database = openDatabase(':memory:');
  try {
    const table = database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'event_advocacies'",
    ).get() as { name: string } | undefined;
    assert.equal(table?.name, 'event_advocacies');
  } finally {
    database.close();
  }
});

test('v28 active advocate notes survive the v29 upgrade as awaiting confirmation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-event-advocacy-'));
  const databasePath = path.join(root, 'legacy.db');
  let legacy: DatabaseSync | undefined;
  let database: ReturnType<typeof openDatabase> | undefined;
  try {
    legacy = new DatabaseSync(databasePath);
    legacy.exec('PRAGMA foreign_keys = ON; CREATE TABLE schema_version (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL); INSERT INTO schema_version VALUES (1, 0);');
    for (const migration of migrations.filter(({ version }) => version <= 28)) {
      migration.up(legacy);
      legacy.prepare('UPDATE schema_version SET version = ? WHERE id = 1').run(migration.version);
    }
    legacy.prepare(`
      INSERT INTO events (
        account, source_group_id, anchor_message_id, title, summary, participant_ids_json,
        evidence_message_ids_json, occurred_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(7, 80, 'g-1', '周末漫展', '群友约好周末参加漫展', '[42]', '["g-1"]', 10, 10, 10);
    const event = legacy.prepare('SELECT id FROM events WHERE account = ? AND anchor_message_id = ?')
      .get(7, 'g-1') as { id: number };
    const eventId = event.id;
    legacy.prepare(`
      INSERT INTO event_notes (
        account, event_id, owner_id, source_session_id, text, intent, level, status,
        source_message_ids_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(7, eventId, 42, '7:private:42', '帮我在群里澄清集合时间', 'advocate', 'L2', 'active', '["p-1"]', 20, 20);
    legacy.close();
    legacy = undefined;

    database = openDatabase(databasePath);
    const advocacy = database.prepare(
      'SELECT account, event_id, owner_id, status FROM event_advocacies WHERE event_id = ?',
    ).get(eventId) as { account: number; event_id: number; owner_id: number; status: string } | undefined;
    const retainedNote = database.prepare(
      'SELECT intent, status FROM event_notes WHERE event_id = ?',
    ).get(eventId) as { intent: string; status: string } | undefined;

    assert.ok(advocacy);
    assert.equal(advocacy.account, 7);
    assert.equal(advocacy.event_id, eventId);
    assert.equal(advocacy.owner_id, 42);
    assert.equal(advocacy.status, 'awaiting_confirmation');
    assert.ok(retainedNote);
    assert.equal(retainedNote.intent, 'advocate');
    assert.equal(retainedNote.status, 'active');
  } finally {
    if (legacy?.isOpen) legacy.close();
    if (database?.isOpen) database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('event advocacy requires recorded private confirmation and can be claimed once', () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    const eventId = repository.upsertGroupEvent({
      account: 7,
      sourceGroupId: 80,
      anchorMessageId: 'g-1',
      title: '周末漫展',
      summary: '群友约好周末参加漫展',
      participantIds: [42],
      evidenceMessageIds: ['g-1'],
      occurredAt: 10,
      createdAt: 10,
      updatedAt: 10,
    });
    repository.upsertGroupEventNote({
      account: 7,
      eventId,
      ownerId: 42,
      sourceSessionId: '7:private:42',
      text: '帮我在群里澄清集合时间',
      intent: 'advocate',
      level: 'L2',
      status: 'active',
      sourceMessageIds: ['p-1'],
      createdAt: 20,
      updatedAt: 20,
    });
    const advocacy = repository as unknown as EventAdvocacyRepository;

    assert.equal(advocacy.ensureEventAdvocacyPending({
      account: 7,
      eventId,
      ownerId: 42,
      sourceSessionId: '7:private:42',
      requestedAt: 30,
    })?.status, 'awaiting_confirmation');
    assert.equal(advocacy.confirmEventAdvocacy({
      account: 7,
      eventId,
      ownerId: 42,
      promptMessageId: 'private-prompt',
      confirmationMessageId: 'private-yes',
      confirmedAt: 40,
    }), false);
    assert.equal(advocacy.markEventAdvocacyPrompted({
      account: 7,
      eventId,
      ownerId: 42,
      promptMessageId: 'private-prompt',
      promptedAt: 35,
    }), true);
    assert.equal(advocacy.confirmEventAdvocacy({
      account: 7,
      eventId,
      ownerId: 42,
      promptMessageId: 'private-prompt',
      confirmationMessageId: 'private-yes',
      confirmedAt: 40,
    }), true);
    assert.equal(advocacy.claimEventAdvocacy(7, eventId, 50), true);
    assert.equal(advocacy.claimEventAdvocacy(7, eventId, 51), false);
    assert.equal(advocacy.finishEventAdvocacy({
      account: 7,
      eventId,
      status: 'sent',
      sentMessageId: 'group-out-1',
      sentAt: 60,
      updatedAt: 60,
    }), true);
    assert.equal(advocacy.ensureEventAdvocacyPending({
      account: 7,
      eventId,
      ownerId: 42,
      sourceSessionId: '7:private:42',
      requestedAt: 70,
    })?.status, 'sent');
    assert.equal(advocacy.eventAdvocacyByEvent(7, eventId)?.sentMessageId, 'group-out-1');
  } finally {
    database.close();
  }
});

test('private advocacy confirmation is tied to the recorded event prompt and owner reply', () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    const eventId = repository.upsertGroupEvent({
      account: 7,
      sourceGroupId: 80,
      anchorMessageId: 'g-1',
      title: '周末漫展',
      summary: '群友约好周末参加漫展',
      participantIds: [42],
      evidenceMessageIds: ['g-1'],
      occurredAt: 10,
      createdAt: 10,
      updatedAt: 10,
    });
    repository.upsertGroupEventNote({
      account: 7,
      eventId,
      ownerId: 42,
      sourceSessionId: '7:private:42',
      text: '帮我在群里澄清集合时间',
      intent: 'advocate',
      level: 'L2',
      status: 'active',
      sourceMessageIds: ['p-1'],
      createdAt: 20,
      updatedAt: 20,
    });
    repository.ensureEventAdvocacyPending({
      account: 7,
      eventId,
      ownerId: 42,
      sourceSessionId: '7:private:42',
      requestedAt: 30,
    });
    const session = { account: 7, kind: 'private' as const, peer: 42 };
    const request = buildEventAdvocacyConfirmationRequest({
      repository,
      session,
      targetSessionId: '7:private:42',
      now: 31,
    });
    assert.equal(request?.eventId, eventId);
    assert.match(request?.request ?? '', /那我去群里说一下/);

    const promptText = '那我去群里说一下「周末漫展」的事，可以吗？';
    repository.saveMessage({
      sessionId: '7:private:42',
      messageId: 'private-prompt',
      senderId: 7,
      senderName: 'Aquarium',
      isSelf: true,
      plainText: promptText,
      segments: [],
      time: 35,
    });
    assert.equal(markEventAdvocacyConfirmationPrompt({
      repository,
      session,
      eventId,
      messageId: 'private-prompt',
      replyText: promptText,
      now: 35,
    }), true);
    repository.saveMessage({
      sessionId: '7:private:42',
      messageId: 'private-yes',
      senderId: 42,
      senderName: '主人',
      isSelf: false,
      plainText: '可以',
      segments: [],
      time: 40,
    });

    assert.deepEqual(processEventAdvocacyConfirmationMessage({
      repository,
      session,
      messageId: 'private-yes',
      senderId: 42,
      now: 40,
    }), { confirmedEventIds: [eventId], cancelledEventIds: [] });
    assert.equal(repository.eventAdvocacyByEvent(7, eventId)?.status, 'confirmed');
  } finally {
    database.close();
  }
});
