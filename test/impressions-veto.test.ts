import assert from 'node:assert/strict';
import test from 'node:test';
import { createImpressionsService } from '../src/core/impressions/service.ts';
import { sessionId } from '../src/core/shared/events.ts';
import type { ExtractTagsPromptTemplate } from '../src/core/prompt/templates.ts';
import { authHeaders, groupSession, now, withPanel } from './panel-test-helpers.ts';

test('删除标签后精确命中否决；撤销否决后可以重新学到', async () => {
  await withPanel(async ({ app, repository, getConfig }) => {
    const key = sessionId(groupSession);
    const tagId = repository.insertTag({
      account: groupSession.account,
      sessionId: key,
      userId: null,
      text: '不聊政治',
      norm: '不聊政治',
      category: 'norms',
      subject: null,
      polarity: null,
      origin: 'manual',
      locked: false,
      status: 'confirmed',
      source: 'manual',
      samples: 1,
      evidence: [],
      firstSeen: now,
      lastSeen: now,
      supersededBy: null,
      updatedAt: now,
    });
    const deleted = await app.request(`/api/tags/${tagId}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    assert.equal(deleted.status, 204);
    assert.equal(repository.tagById(tagId), undefined);

    const list = await app.request(`/api/tag-vetoes?sessionId=${encodeURIComponent(key)}`, {
      headers: authHeaders(),
    });
    assert.equal(list.status, 200);
    const vetoes = await list.json() as Array<{ id: number; category: string; textNorm: string }>;
    assert.equal(vetoes.length, 1);
    assert.equal(vetoes[0]?.category, 'norms');
    assert.equal(vetoes[0]?.textNorm, '不聊政治');

    let messageId = 'vetoed-message';
    let at = now + 1_000;
    const template: ExtractTagsPromptTemplate = {
      source: 'fixture',
      version: 'fixture-v1',
      system: '提取群聊印象。',
      user: '上下文：{{context}}\n现有：{{existing}}',
    };
    const service = createImpressionsService({
      repository,
      getConfig,
      now: () => at,
      callModel: async () => ({
        text: JSON.stringify({
          group: {
            observe: [],
            new: [{
              text: '不聊政治', messageId, category: 'norms', subject: null,
              polarity: null, origin: 'inferred', sensitive: false,
            }],
            contradict: [],
          },
          members: [],
        }),
        provider: 'fake',
        model: 'fake-model',
        usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
      }),
    });
    const extract = async () => {
      const release = service.tryAcquireSession(key);
      assert.ok(release);
      try {
        return await service.extractWindowUnderSessionLock({
          session: groupSession,
          records: [{
            sessionId: key,
            messageId,
            senderId: 42,
            senderName: '群友',
            isSelf: false,
            plainText: '群友说我们不聊政治',
            segments: [],
            time: at,
          }],
          now: at,
          template,
        });
      } finally {
        release();
      }
    };

    const blocked = await extract();
    assert.equal(blocked.inserted, 0);
    assert.deepEqual(blocked.droppedTagReasons, { vetoed: 1 });
    assert.equal(repository.listTagsForSubject(groupSession.account, key, null).length, 0);

    const revoked = await app.request(`/api/tag-vetoes/${vetoes[0]?.id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    assert.equal(revoked.status, 204);
    messageId = 'after-revoke-message';
    at += 1_000;
    const learned = await extract();
    assert.equal(learned.inserted, 1);
    assert.equal(repository.listTagsForSubject(groupSession.account, key, null)[0]?.text, '不聊政治');
  });
});
