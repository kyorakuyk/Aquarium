import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionId } from '../src/core/shared/events.ts';
import { buildMemberTagPrompt } from '../src/core/impressions/member-tags.ts';
import { promptTemplateStore } from '../src/core/prompt/templates.ts';
import { createTagSubjectRepository } from '../src/store/tag-subject-repo.ts';
import { account, authHeaders, groupSession, now, withPanel } from './panel-test-helpers.ts';

function jsonHeaders(): HeadersInit {
  return { ...authHeaders(), 'Content-Type': 'application/json' };
}

test('画像卡实际注入行与提示词一致，并只包含 fact 标签', async () => {
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
      members: Array<{
        memberTagsAllowed: boolean;
        memberTagsText: string | null;
        tags: Array<{ text: string; kind: 'fact' | 'view' }>;
      }>;
    };
    const member = body.members[0]!;
    const storedTags = repository.listTagsForSubject(account, key, 42);
    const selected = buildMemberTagPrompt(storedTags.filter((tag) => tag.kind === 'fact'), now);
    const expected = promptTemplateStore.get().replySystem.memberTags
      .replaceAll('{{name}}', JSON.stringify('小明'))
      .replaceAll('{{profile}}', '')
      .replaceAll('{{tags}}', selected.text);

    assert.equal(response.status, 200);
    assert.equal(member.memberTagsAllowed, true);
    assert.equal(member.tags.find((tag) => tag.text === '幽默')?.kind, 'view');
    assert.equal(member.tags.find((tag) => tag.text === 'INTJ')?.kind, 'fact');
    assert.equal(member.memberTagsText, expected);
    assert.equal(member.memberTagsText?.includes('幽默'), false);
    assert.equal(member.memberTagsText?.includes('CS2'), false);
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
      body: JSON.stringify({ sessionId: key, userId: 42, text: 'sk-abc123def456ghi789', category: 'personality' }),
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

test('标签 API 按 v2 scope 校验，并逐级归一 topic subject 别名', async () => {
  await withPanel(async ({ app, database, repository }) => {
    const key = sessionId(groupSession);
    const subjects = createTagSubjectRepository(database);
    subjects.saveTagSubject({ account, category: 'topic', name: '游戏', aliases: ['玩法'] });
    subjects.saveTagSubject({ account, category: 'topic', name: '射击', aliases: ['FPS'] });

    const groupTopic = await app.request('/api/tags', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        sessionId: key,
        userId: null,
        text: 'CS2',
        category: 'topic',
        subject: '玩法/FPS',
      }),
    });
    assert.equal(groupTopic.status, 200, await groupTopic.clone().text());
    const created = await groupTopic.json() as { id: number; subject: string | null };
    assert.equal(created.subject, '游戏/射击');
    assert.equal(repository.tagById(created.id)?.subject, '游戏/射击');

    const oneLevelFandom = await app.request('/api/tags', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ sessionId: key, userId: 42, text: 'CS2', category: 'fandom', subject: null, polarity: null }),
    });
    assert.equal(oneLevelFandom.status, 200);
    assert.equal((await oneLevelFandom.json() as { subject: string | null }).subject, null);

    const invalidMemberPositioning = await app.request('/api/tags', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ sessionId: key, userId: 42, text: '交友', category: 'positioning' }),
    });
    assert.equal(invalidMemberPositioning.status, 400);
  });
});
