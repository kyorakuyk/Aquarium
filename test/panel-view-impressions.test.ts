import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionId } from '../src/core/shared/events.ts';
import { promptTemplateStore } from '../src/core/prompt/templates.ts';
import type { TagRecord } from '../src/store/affect-repo.ts';
import { account, authHeaders, groupSession, now, withPanel } from './panel-test-helpers.ts';

function viewTag(overrides: Partial<TagRecord> = {}): TagRecord {
  return {
    account,
    sessionId: sessionId(groupSession),
    userId: 42,
    text: '喜欢猫',
    norm: '喜欢猫',
    kind: 'view',
    category: 'personality',
    subject: null,
    polarity: null,
    origin: 'inferred',
    locked: false,
    status: 'confirmed',
    source: 'auto',
    samples: 2,
    evidence: [],
    firstSeen: now - 1_000,
    lastSeen: now,
    supersededBy: null,
    updatedAt: now,
    ...overrides,
  };
}

test('view-impression 面板按成员读取，并支持手动确定与删除', async () => {
  await withPanel(async ({ app, repository }) => {
    const id = repository.insertTag(viewTag());
    repository.saveMessage({
      sessionId: sessionId(groupSession),
      messageId: 'view-member-name',
      senderId: 42,
      senderName: '小明',
      isSelf: false,
      plainText: '你好',
      segments: [],
      time: now,
    });

    assert.equal((await app.request(`/api/accounts/${account}/view-impressions`)).status, 401);
    const listResponse = await app.request(`/api/accounts/${account}/view-impressions`, { headers: authHeaders() });
    assert.equal(listResponse.status, 200);
    const list = await listResponse.json() as { tags: Array<{ id: number; name: string; userId: number | null; certain: boolean; text: string }> };
    assert.deepEqual(list.tags.map(({ id: tagId, name, userId, certain, text }) => ({ tagId, name, userId, certain, text })), [
      { tagId: id, name: '小明', userId: 42, certain: false, text: '喜欢猫' },
    ]);

    const confirmed = await app.request(`/api/accounts/${account}/view-impressions/${id}/confirm`, {
      method: 'POST',
      headers: authHeaders(),
    });
    assert.equal(confirmed.status, 200);
    const confirmedBody = await confirmed.json() as { certain: boolean; origin: string; source: string };
    assert.equal(confirmedBody.certain, true);
    assert.equal(confirmedBody.origin, 'manual');
    assert.equal(confirmedBody.source, 'manual');
    const stored = repository.tagById(id);
    assert.equal(stored?.certain, true);
    assert.equal(stored?.origin, 'manual');
    assert.equal(stored?.source, 'manual');

    const deleted = await app.request(`/api/accounts/${account}/view-impressions/${id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    assert.equal(deleted.status, 204);
    assert.equal(repository.tagById(id), undefined);
  });
});

test('手动确认 candidate view 会转为确定并注入印象块', async () => {
  await withPanel(async ({ app, repository, impressionsService }) => {
    const id = repository.insertTag(viewTag({ status: 'candidate' }));
    const response = await app.request(`/api/accounts/${account}/view-impressions/${id}/confirm`, {
      method: 'POST',
      headers: authHeaders(),
    });
    assert.equal(response.status, 200);
    const updated = repository.tagById(id);
    assert.equal(updated?.status, 'confirmed');
    assert.equal(updated?.certain, true);
    assert.equal(updated?.origin, 'manual');
    assert.equal(updated?.source, 'manual');

    const key = sessionId(groupSession);
    const blocks = impressionsService.promptBlocks({
      session: groupSession,
      sessionId: key,
      senderId: 42,
      senderName: '小明',
      now,
      template: promptTemplateStore.get().replySystem,
    });
    assert.match(blocks.impressions ?? '', /喜欢猫/u);
    assert.doesNotMatch(blocks.impressions ?? '', /喜欢猫\?/u);
  });
});

test('提升适合的 view 为知识后会退出印象块并进入知识块', async () => {
  await withPanel(async ({ app, repository, impressionsService }) => {
    const id = repository.insertTag(viewTag({
      category: 'fandom',
      polarity: 'like',
      text: '热爱开源',
      norm: '热爱开源',
      samples: 2,
    }));
    const key = sessionId(groupSession);
    const promptInput = {
      session: groupSession,
      sessionId: key,
      senderId: 42,
      senderName: '小明',
      now,
      template: promptTemplateStore.get().replySystem,
    };
    const before = impressionsService.promptBlocks(promptInput);
    assert.match(before.impressions ?? '', /热爱开源\?/u);

    const response = await app.request(`/api/accounts/${account}/view-impressions/${id}/promote`, {
      method: 'POST',
      headers: authHeaders(),
    });
    assert.equal(response.status, 200);
    const updated = repository.tagById(id);
    assert.equal(updated?.kind, 'fact');
    assert.equal(updated?.certain, false);

    const list = await (await app.request(`/api/accounts/${account}/view-impressions`, { headers: authHeaders() })).json() as {
      tags: Array<{ id: number }>;
    };
    assert.equal(list.tags.some((tag) => tag.id === id), false);
    const after = impressionsService.promptBlocks(promptInput);
    assert.doesNotMatch(after.impressions ?? '', /热爱开源/u);
    assert.match(after.memberTags ?? '', /热爱开源/u);
  });
});

test('view 分类不适合提升为知识时，API 返回原因且不改标签', async () => {
  await withPanel(async ({ app, repository }) => {
    const id = repository.insertTag(viewTag());
    const response = await app.request(`/api/accounts/${account}/view-impressions/${id}/promote`, {
      method: 'POST',
      headers: authHeaders(),
    });
    assert.equal(response.status, 422);
    const body = await response.json() as { reason: string };
    assert.match(body.reason, /主观看法/u);
    assert.equal(repository.tagById(id)?.kind, 'view');
  });
});

test('私聊来源的印象不能提升为共享知识，API 返回原因且保留 view', async () => {
  await withPanel(async ({ app, repository }) => {
    const privateSource = { account, kind: 'private' as const, peer: 42 };
    const id = repository.insertTag(viewTag({
      sessionId: sessionId(privateSource),
      category: 'fandom',
      polarity: 'like',
      text: '喜欢猫',
      norm: '喜欢猫',
    }));
    const response = await app.request(`/api/accounts/${account}/view-impressions/${id}/promote`, {
      method: 'POST',
      headers: authHeaders(),
    });
    assert.equal(response.status, 422);
    const body = await response.json() as { reason: string };
    assert.match(body.reason, /私聊来源/u);
    assert.equal(repository.tagById(id)?.kind, 'view');
  });
});
