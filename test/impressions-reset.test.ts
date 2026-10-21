import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sessionId } from '../src/core/shared/events.ts';
import { account, authHeaders, groupSession, now, withPanel } from './panel-test-helpers.ts';

function jsonHeaders(): HeadersInit {
  return { ...authHeaders(), 'Content-Type': 'application/json' };
}

function tag(accountId: number, session: string, userId: number | null, text: string, category: 'topic' | 'personality') {
  return {
    account: accountId,
    sessionId: session,
    userId,
    text,
    norm: text,
    category,
    subject: null,
    polarity: null,
    origin: 'manual' as const,
    locked: false,
    status: 'confirmed' as const,
    source: 'manual' as const,
    samples: 1,
    evidence: [],
    firstSeen: now,
    lastSeen: now,
    supersededBy: null,
    updatedAt: now,
  };
}

test('reset requires the current group name and preserves shared data and other sessions', async () => {
  await withPanel(async ({ app, root, repository, memberSummaryRepository }) => {
    const groupId = sessionId(groupSession);
    const otherGroupId = sessionId({ ...groupSession, peer: 654321 });
    repository.insertTag(tag(account, groupId, 42, '喜欢旅行', 'personality'));
    repository.insertTag(tag(account, groupId, null, '鸣潮', 'topic'));
    repository.insertTag(tag(account, otherGroupId, 42, '摄影', 'personality'));
    repository.insertTagVeto({
      account,
      sessionId: groupId,
      userId: 42,
      category: 'personality',
      subjectNorm: '',
      textNorm: '不再学习',
      createdAt: now,
    });
    repository.insertTagVeto({
      account,
      sessionId: otherGroupId,
      userId: 42,
      category: 'personality',
      subjectNorm: '',
      textNorm: '保留否决',
      createdAt: now,
    });
    repository.saveTagRun({ account, sessionId: groupId, lastRunAt: now, lastMessageTime: now });
    repository.saveTagRun({ account, sessionId: otherGroupId, lastRunAt: now, lastMessageTime: now });
    repository.setAccountKind(account, 42, 'human', now);
    repository.saveManualGroupSummary({ account, sessionId: groupId, text: '当前群的摘要', updatedAt: now });
    repository.saveManualGroupSummary({ account, sessionId: otherGroupId, text: '另一群的摘要', updatedAt: now });
    repository.recordTagDrop({
      account,
      sessionId: groupId,
      userId: null,
      category: 'schedule',
      text: '最近总是熬夜',
      reason: 'schedule_by_stats',
      time: now,
    });
    repository.createRelation({
      account,
      aUserId: 42,
      bUserId: 43,
      type: 'lover',
      label: null,
      locked: true,
      createdAt: now,
    });

    const summaryResponse = await app.request(`/api/member-summaries/${groupId}/42`, {
      method: 'PUT',
      headers: jsonHeaders(),
      body: JSON.stringify({ text: '喜欢旅行与摄影' }),
    });
    assert.equal(summaryResponse.status, 200);
    const subjectResponse = await app.request(`/api/tag-subjects/${groupId}/topic`, {
      method: 'PUT',
      headers: jsonHeaders(),
      body: JSON.stringify({ name: '鸣潮', aliases: ['WW'] }),
    });
    assert.equal(subjectResponse.status, 200);

    const wrongConfirmation = await app.request('/api/impressions/reset', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ sessionId: groupId, confirm: '别的群' }),
    });
    assert.equal(wrongConfirmation.status, 400);
    assert.equal(repository.listTagsForSession(account, groupId).length, 2);

    const reset = await app.request('/api/impressions/reset', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ sessionId: groupId, confirm: '测试群' }),
    });
    assert.equal(reset.status, 200);
    assert.equal(repository.listTagsForSession(account, groupId).length, 0);
    assert.equal(repository.listTagVetoes(account, groupId).length, 0);
    assert.equal(repository.getTagRun(account, groupId), undefined);
    assert.equal(repository.getGroupSummary(account, groupId), undefined);
    assert.equal(repository.latestScheduleDrop(account, groupId, null, now - 7 * 24 * 60 * 60 * 1_000), undefined);
    assert.equal(repository.listTagsForSession(account, otherGroupId).length, 1);
    assert.equal(repository.getGroupSummary(account, otherGroupId)?.text, '另一群的摘要');
    assert.equal(repository.listTagVetoes(account, otherGroupId).length, 1);
    assert.notEqual(repository.getTagRun(account, otherGroupId), undefined);
    assert.equal(repository.getAccountKind(account, 42)?.kind, 'human');
    assert.equal(repository.listRelationsForUser(account, 42).length, 1);

    assert.equal(memberSummaryRepository.get(account, 42)?.text, '喜欢旅行与摄影');
    const subjectsRead = await app.request(`/api/tag-subjects/${groupId}/topic`, { headers: authHeaders() });
    assert.match(await subjectsRead.text(), /鸣潮/);

    const backups = fs.readdirSync(path.join(root, 'data', 'backups'));
    assert.equal(backups.length, 1);
    const backup = JSON.parse(fs.readFileSync(path.join(root, 'data', 'backups', backups[0] ?? ''), 'utf8')) as {
      version: number;
      sessionId: string;
      tags: unknown[];
      groupSummary?: { text: string };
      privateFactsL1?: unknown;
    };
    assert.equal(backup.version, 1);
    assert.equal(backup.sessionId, groupId);
    assert.equal(backup.tags.length, 2);
    assert.equal(backup.groupSummary?.text, '当前群的摘要');
    assert.equal(backup.privateFactsL1, undefined);
  });
});

test('import and reset stop before mutation when the automatic backup cannot be written', async () => {
  await withPanel(async ({ app, root, repository }) => {
    const groupId = sessionId(groupSession);
    repository.insertTag(tag(account, groupId, 42, '保留标签', 'personality'));
    const dataDirectory = path.join(root, 'data');
    fs.mkdirSync(dataDirectory, { recursive: true });
    fs.writeFileSync(path.join(dataDirectory, 'backups'), 'not-a-directory', 'utf8');
    const file = {
      version: 1,
      exportedAt: new Date(now).toISOString(),
      account,
      sessionId: groupId,
      groupName: '测试群',
      tags: [{
        userId: 42,
        text: '新增标签',
        norm: '新增标签',
        category: 'personality',
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
        updatedAt: now,
      }],
      summaries: [],
      subjects: [],
      vetoes: [],
      relations: [],
      accountKinds: [],
      mode: 'merge',
    };

    const imported = await app.request('/api/impressions/import', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify(file),
    });
    assert.equal(imported.status, 500);
    assert.equal(repository.listTagsForSession(account, groupId).length, 1);

    const reset = await app.request('/api/impressions/reset', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ sessionId: groupId, confirm: '测试群' }),
    });
    assert.equal(reset.status, 500);
    assert.equal(repository.listTagsForSession(account, groupId).length, 1);
  });
});
