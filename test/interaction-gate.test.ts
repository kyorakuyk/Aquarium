import assert from 'node:assert/strict';
import test from 'node:test';
import { openDatabase } from '../src/store/db.ts';
import { createInteractionLogRepository } from '../src/store/interaction-log-repo.ts';
import { groupSession } from './pipeline-test-helpers.ts';

 test('interaction decisions persist and read back only for the matching session/message', () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createInteractionLogRepository(database);
    const input = {
      account: groupSession.account,
      time: 10,
      sessionId: `${groupSession.account}:group:${groupSession.peer}`,
      messageId: 'notice-1',
      actionKind: 'react' as const,
      target: 'notice-1',
      source: 'rule' as const,
      verdict: 'dry_run' as const,
      reason: 'dry_run',
    };
    repository.recordInteractionLog(input);
    const rows = repository.interactionLogsForMessage(input.sessionId, input.messageId);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], { id: 1, ...input });
    assert.deepEqual(repository.interactionLogsForMessage('different-session', input.messageId), []);
  } finally {
    database.close();
  }
});
