import assert from 'node:assert/strict';
import test from 'node:test';
import { createAffinityService } from '../src/core/affinity/service.ts';
import { sessionId } from '../src/core/shared/events.ts';
import { baseTime, groupSession, makeConfig, withRepository } from './pipeline-test-helpers.ts';

test('小号的好感变化、读取与手动设置都落在主号', async () => {
  await withRepository(async (repository) => {
    const account = groupSession.account;
    const mainUserId = 42;
    const altUserId = 43;
    const service = createAffinityService({
      repository,
      getConfig: () => makeConfig({ affinity: { enabled: true, initial: 50 } }),
    });
    repository.linkAltAccount({ account, aUserId: mainUserId, bUserId: altUserId, createdAt: baseTime });

    service.recordCalled({ account, userId: altUserId, sessionId: sessionId(groupSession), now: baseTime });
    service.recordAppraise({
      account,
      userId: altUserId,
      sessionId: sessionId(groupSession),
      appliedDv: 0.15,
      time: baseTime + 1_000,
      reason: '友好回应',
    });
    const mapped = service.getCurrent(account, altUserId, baseTime + 1_000);
    assert.equal(mapped.userId, mainUserId);
    assert.equal(repository.getAffinityState(account, altUserId), undefined);
    assert.ok(repository.getAffinityState(account, mainUserId));
    assert.ok(repository.recentAffinityEvents(account, mainUserId, 10).every((event) => event.userId === mainUserId));

    service.setManual({ account, userId: altUserId, value: 70, now: baseTime + 2_000 });
    assert.equal(repository.getAffinityState(account, mainUserId)?.value, 70);
    assert.equal(service.listCurrent(account, baseTime + 2_000).length, 1);
  });
});
