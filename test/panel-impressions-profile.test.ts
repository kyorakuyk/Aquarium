import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionId } from '../src/core/shared/events.ts';
import { buildMemberTagPrompt } from '../src/core/impressions/member-tags.ts';
import { promptTemplateStore } from '../src/core/prompt/templates.ts';
import { account, authHeaders, groupSession, now, withPanel } from './panel-test-helpers.ts';

function jsonHeaders(): HeadersInit {
  return { ...authHeaders(), 'Content-Type': 'application/json' };
}

test('画像卡注入文本与提示词一致，并排除锁定和 misc 标签', async () => {
  await withPanel(async ({ app, repository }) => {
    const key = sessionId(groupSession);
    const addTag = (tag: {
      text: string;
      category: 'personality' | 'fandom' | 'identity' | 'misc';
      origin: 'inferred' | 'self_report';
      locked: boolean;
      subject?: string;
      polarity?: 'like' | null;
    }) => repository.insertTag({
      account,
      sessionId: key,
      userId: 42,
      norm: tag.text.toLowerCase(),
      text: tag.text,
      category: tag.category,
      subject: tag.subject ?? null,
      polarity: tag.polarity ?? null,
      origin: tag.origin,
      locked: tag.locked,
      status: 'confirmed',
      source: 'auto',
      samples: 2,
      evidence: [],
      firstSeen: now,
      lastSeen: now,
      supersededBy: null,
      updatedAt: now,
    });
    addTag({ text: '幽默', category: 'personality', origin: 'inferred', locked: false });
    addTag({ text: 'CS2', category: 'fandom', origin: 'inferred', locked: false, subject: '游戏', polarity: 'like' });
    addTag({ text: 'INTJ', category: 'identity', origin: 'self_report', locked: false });
    addTag({ text: '锁定标签', category: 'personality', origin: 'inferred', locked: true });
    addTag({ text: '旧 misc 标签', category: 'misc', origin: 'inferred', locked: false });
    repository.saveMessage({
      sessionId: key,
      messageId: 'profile-prompt-name',
      senderId: 42,
      senderName: '小明',
      isSelf: false,
      plainText: '晚上好',
      segments: [],
      time: now,
    });

    const response = await app.request(`/api/impressions/${key}`, { headers: authHeaders() });
    const body = await response.json() as {
      members: Array<{ memberTagsAllowed: boolean; memberTagsText: string | null }>;
    };
    const member = body.members[0]!;
    const storedTags = repository.listTagsForSubject(account, key, 42);
    const selected = buildMemberTagPrompt(storedTags, now);
    const expected = promptTemplateStore.get().replySystem.memberTags
      .replaceAll('{{name}}', JSON.stringify('小明'))
      .replaceAll('{{tags}}', selected.text);

    assert.equal(response.status, 200);
    assert.equal(member.memberTagsAllowed, true);
    assert.equal(member.memberTagsText, expected);
    assert.equal(member.memberTagsText?.includes('锁定标签'), false);
    assert.equal(member.memberTagsText?.includes('旧 misc 标签'), false);
  });
});

test('标签 API 接受成分层级，并可加锁与解锁', async () => {
  await withPanel(async ({ app, repository }) => {
    const key = sessionId(groupSession);
    const sensitiveTag = await app.request('/api/tags', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ sessionId: key, userId: 42, text: ['K9m4R2p8', 'T1v6'].join(''), category: 'personality' }),
    });
    assert.equal(sensitiveTag.status, 400);

    const response = await app.request('/api/tags', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        sessionId: key,
        userId: 42,
        text: 'CS2',
        category: 'fandom',
        subject: '游戏',
        polarity: 'like',
      }),
    });
    assert.equal(response.status, 200);
    const created = await response.json() as {
      id: number;
      category: string;
      subject: string | null;
      polarity: string | null;
      origin: string;
      locked: boolean;
    };
    assert.deepEqual(
      [created.category, created.subject, created.polarity, created.origin, created.locked],
      ['fandom', '游戏', 'like', 'manual', false],
    );

    const lock = await app.request(`/api/tags/${created.id}`, {
      method: 'PATCH',
      headers: jsonHeaders(),
      body: JSON.stringify({ locked: true }),
    });
    assert.equal(lock.status, 200);
    assert.equal((await lock.json() as { locked: boolean }).locked, true);
    assert.equal(repository.tagById(created.id)?.locked, true);

    const unlock = await app.request(`/api/tags/${created.id}`, {
      method: 'PATCH',
      headers: jsonHeaders(),
      body: JSON.stringify({ locked: false }),
    });
    assert.equal(unlock.status, 200);
    assert.equal((await unlock.json() as { locked: boolean }).locked, false);
    assert.equal(repository.tagById(created.id)?.locked, false);
  });
});
