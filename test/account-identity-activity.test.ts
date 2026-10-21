import assert from 'node:assert/strict';
import test from 'node:test';
import { createPanelApp } from '../src/panel-server/app.ts';
import { createProfileActivityService } from '../src/core/profiles/presence-service.ts';
import { createActivitySuggestionRepository } from '../src/store/activity-suggestion-repo.ts';
import { openDatabase } from '../src/store/db.ts';
import { createRepository } from '../src/store/repository.ts';
import { sessionId, type SessionKey } from '../src/core/shared/events.ts';
import { makeConfig } from './pipeline-test-helpers.ts';

const password = 'test-panel-password';
const headers = { Authorization: `Bearer ${password}` };

test('活动热图将已链接小号合并到主号，解除后小号消息独立统计', async () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    const suggestionRepository = createActivitySuggestionRepository(database);
    const account = makeConfig().accounts[0]!.uin;
    const session: SessionKey = { account, kind: 'group', peer: 99123 };
    const id = sessionId(session);
    const config = makeConfig({ sessions: { [id]: { enabled: true } } });
    const now = new Date(2026, 5, 10, 22, 0, 0, 0).getTime();
    const profileActivity = createProfileActivityService({
      repository,
      suggestionRepository,
      getConfig: () => config,
      now: () => now,
    });
    const app = createPanelApp({
      password,
      getConfig: () => config,
      saveConfig: () => {},
      repository,
      accounts: () => [],
      management: () => [],
      profileActivity,
      now: () => now,
    });
    for (let index = 0; index < 50; index += 1) {
      const time = new Date(now);
      time.setDate(time.getDate() - index);
      time.setHours(20, 10, 0, 0);
      repository.saveMessage({
        sessionId: id,
        messageId: `main-${index}`,
        senderId: 42,
        senderName: '主号昵称',
        isSelf: false,
        plainText: '主号发言',
        segments: [{ type: 'text', text: '主号发言' }],
        time: time.getTime(),
      });
    }
    for (let index = 0; index < 10; index += 1) {
      repository.saveMessage({
        sessionId: id,
        messageId: `alt-${index}`,
        senderId: 43,
        senderName: '小号昵称',
        isSelf: false,
        plainText: '小号发言',
        segments: [{ type: 'text', text: '小号发言' }],
        time: now - index * 60_000,
      });
    }
    const relation = repository.linkAltAccount({ account, aUserId: 42, bUserId: 43, createdAt: now });
    const memberActivity = async (userId: number): Promise<number> => {
      const response = await app.request(
        `/api/activity?sessionId=${encodeURIComponent(id)}&view=hour&userId=${userId}`,
        { headers },
      );
      const result = await response.json() as { summary: { total: number } };
      return result.summary.total;
    };

    assert.equal(await memberActivity(42), 60);
    assert.equal(await memberActivity(43), 60);
    assert.equal(repository.deleteRelation(account, relation.id), true);
    repository.saveMessage({
      sessionId: id,
      messageId: 'alt-after-unlink',
      senderId: 43,
      senderName: '小号昵称',
      isSelf: false,
      plainText: '解除后发言',
      segments: [{ type: 'text', text: '解除后发言' }],
      time: now,
    });
    assert.equal(await memberActivity(42), 50);
    assert.equal(await memberActivity(43), 11);
  } finally {
    database.close();
  }
});
