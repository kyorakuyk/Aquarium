import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPersonaMemoryService } from '../src/core/persona-memory.ts';
import { openDatabase } from '../src/store/db.ts';
import { createRepository } from '../src/store/repository.ts';
import { makeConfig, makeIncoming } from './pipeline-test-helpers.ts';

const sessionId = '7101:group:82';
const startAt = 1_800_000_000_000;

function method<T extends (...args: never[]) => unknown>(repository: object, name: string): T | undefined {
  return Reflect.get(repository, name) as T | undefined;
}

test('v37 cursor migration is extended with a same-time message watermark', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-memory-cursor-migration-'));
  const databasePath = path.join(root, 'aquarium.db');
  let database = openDatabase(databasePath);
  try {
    const columns = database.prepare("PRAGMA table_info('memory_cursors')").all() as Array<{ name: string }>;
    assert.deepEqual(columns.map(({ name }) => name), [
      'account', 'session_id', 'organized_until_message_time', 'open_segment_start', 'organized_until_message_row_id',
    ]);
    const repository = createRepository(database);
    const saveCursor = method<(cursor: {
      account: number; sessionId: string; organizedUntilMessageTime: number | null; openSegmentStart: number | null;
    }) => void>(repository, 'savePersonaMemoryCursor');
    const getCursor = method<(account: number, session: string) => {
      organizedUntilMessageTime: number | null; openSegmentStart: number | null;
    } | undefined>(repository, 'personaMemoryCursor');
    assert.equal(typeof saveCursor, 'function');
    assert.equal(typeof getCursor, 'function');
    if (!saveCursor || !getCursor) return;
    saveCursor({ account: 7101, sessionId, organizedUntilMessageTime: null, openSegmentStart: startAt });
    database.prepare('UPDATE schema_version SET version = 36 WHERE id = 1').run();
    database.close();
    database = openDatabase(databasePath);
    const reopenedRepository = createRepository(database);
    const reopenedGetCursor = method<(account: number, session: string) => {
      account: number; sessionId: string; organizedUntilMessageTime: number | null; openSegmentStart: number | null;
    } | undefined>(reopenedRepository, 'personaMemoryCursor');
    assert.equal(typeof reopenedGetCursor, 'function');
    if (!reopenedGetCursor) return;
    assert.deepEqual(reopenedGetCursor(7101, sessionId), {
      account: 7101, sessionId, organizedUntilMessageTime: null, organizedUntilMessageRowId: null, openSegmentStart: startAt,
    });
    database.close();
    database = openDatabase(databasePath);
    const finalRepository = createRepository(database);
    const finalGetCursor = method<(account: number, session: string) => {
      account: number; sessionId: string; organizedUntilMessageTime: number | null; openSegmentStart: number | null;
    } | undefined>(finalRepository, 'personaMemoryCursor');
    assert.equal(typeof finalGetCursor, 'function');
    if (!finalGetCursor) return;
    assert.deepEqual(finalGetCursor(7101, sessionId), {
      account: 7101, sessionId, organizedUntilMessageTime: null, organizedUntilMessageRowId: null, openSegmentStart: startAt,
    });
  } finally {
    if (database.isOpen) database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('memory cursor upsert reads pending messages and per-session staging summary back', () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    const saveMessage = method<(message: {
      sessionId: string; messageId: string; senderId: number; senderName: string; isSelf: boolean;
      plainText: string; segments: unknown[]; time: number;
    }) => boolean>(repository, 'saveMessage');
    const saveCursor = method<(cursor: {
      account: number; sessionId: string; organizedUntilMessageTime: number | null;
      organizedUntilMessageRowId?: number | null; openSegmentStart: number | null;
    }) => void>(repository, 'savePersonaMemoryCursor');
    const listPending = method<(account: number, session: string) => Array<{ rowId: number; messageId: string; time: number }>>(
      repository, 'listPersonaMemoryPendingMessages',
    );
    const listSummaries = method<(account: number) => Array<{
      account: number; sessionId: string; pendingMessageCount: number; openSegmentStart: number | null;
      organizedUntilMessageTime: number | null; organizedUntilMessageRowId: number | null;
      latestPendingMessageTime: number | null;
    }>>(repository, 'listPersonaMemoryCursorSummaries');
    assert.equal(typeof saveCursor, 'function');
    assert.equal(typeof listPending, 'function');
    assert.equal(typeof listSummaries, 'function');
    if (!saveCursor || !listPending || !listSummaries || !saveMessage) return;

    const messageIds = ['cursor-0', 'cursor-same-second', 'cursor-1'];
    for (const [index, time] of [startAt, startAt, startAt + 1].entries()) {
      assert.equal(saveMessage({
        sessionId,
        messageId: messageIds[index]!,
        senderId: index === 0 ? 7101 : 82,
        senderName: index === 0 ? 'Aquarium' : '成员',
        isSelf: index === 0,
        plainText: `消息 ${index}`,
        segments: [],
        time,
      }), true);
    }
    saveCursor({ account: 7101, sessionId, organizedUntilMessageTime: null, openSegmentStart: startAt });

    const pendingBefore = listPending(7101, sessionId);
    assert.deepEqual(pendingBefore.map(({ messageId }) => messageId), ['cursor-0', 'cursor-same-second', 'cursor-1']);
    saveCursor({
      account: 7101,
      sessionId,
      organizedUntilMessageTime: startAt,
      organizedUntilMessageRowId: null,
      openSegmentStart: startAt + 1,
    });
    assert.deepEqual(listPending(7101, sessionId).map(({ messageId }) => messageId), [
      'cursor-0', 'cursor-same-second', 'cursor-1',
    ]);
    assert.deepEqual(listSummaries(7101), [{
      account: 7101,
      sessionId,
      organizedUntilMessageTime: startAt,
      organizedUntilMessageRowId: null,
      openSegmentStart: startAt + 1,
      pendingMessageCount: 3,
      latestPendingMessageTime: startAt + 1,
    }]);

    saveCursor({
      account: 7101,
      sessionId,
      organizedUntilMessageTime: startAt,
      organizedUntilMessageRowId: pendingBefore[0]!.rowId,
      openSegmentStart: startAt + 1,
    });
    assert.deepEqual(listPending(7101, sessionId).map(({ messageId }) => messageId), ['cursor-same-second', 'cursor-1']);
    assert.equal(listSummaries(7101)[0]?.pendingMessageCount, 2);
  } finally {
    database.close();
  }
});

test('observeMessage updates the open segment cursor without storing raw memos or running model processing', () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    const saveMessage = method<(message: {
      sessionId: string; messageId: string; senderId: number; senderName: string; isSelf: boolean;
      plainText: string; segments: unknown[]; time: number;
    }) => boolean>(repository, 'saveMessage');
    const listSummaries = method<(account: number) => Array<{
      openSegmentStart: number | null; pendingMessageCount: number;
    }>>(repository, 'listPersonaMemoryCursorSummaries');
    assert.equal(typeof saveMessage, 'function');
    assert.equal(typeof listSummaries, 'function');
    if (!saveMessage || !listSummaries) return;

    let processCalls = 0;
    const service = createPersonaMemoryService({
      repository,
      getConfig: () => makeConfig(),
      processSession: async () => { processCalls += 1; return 'done'; },
    });
    const session = { account: 7101, kind: 'group' as const, peer: 82 };
    const inputMessages = [
      makeIncoming({ session, messageId: 'segment-1', senderId: 42, plainText: '第一条', time: startAt }),
      makeIncoming({ session, messageId: 'segment-2', senderId: 42, plainText: '第二条', time: startAt + 10 * 60_000 }),
      makeIncoming({ session, messageId: 'segment-3', senderId: 42, plainText: '静默后新段', time: startAt + 31 * 60_000 }),
    ];
    for (const message of inputMessages) {
      assert.equal(saveMessage({
        sessionId,
        messageId: message.messageId,
        senderId: message.senderId,
        senderName: '成员',
        isSelf: false,
        plainText: message.plainText,
        segments: [],
        time: message.time,
      }), true);
      assert.equal(service.observeMessage(message), true);
    }

    assert.deepEqual(listSummaries(7101), [{
      account: 7101,
      sessionId,
      organizedUntilMessageTime: null,
      organizedUntilMessageRowId: null,
      openSegmentStart: startAt + 31 * 60_000,
      pendingMessageCount: 3,
      latestPendingMessageTime: startAt + 31 * 60_000,
    }]);
    assert.equal(repository.listPersonaMemos(7101, 10).length, 0);
    assert.equal(processCalls, 0);
  } finally {
    database.close();
  }
});
