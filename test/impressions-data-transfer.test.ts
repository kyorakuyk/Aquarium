import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { sessionId } from '../src/core/shared/events.ts';
import type { TagRecord } from '../src/store/affect-repo.ts';
import { account, authHeaders, groupSession, now, withPanel } from './panel-test-helpers.ts';

function privateFact(ownerId: number, level: 'L0' | 'L1', text: string) {
  return {
    account,
    ownerId,
    sessionId: `${account}:private:${ownerId}`,
    text,
    keywords: ['备份测试', '仅测试'],
    level,
    levelSource: 'manual' as const,
    mentions: 1,
    mentionEvidence: [],
    evidence: [],
    status: 'active' as const,
    createdAt: now,
    updatedAt: now,
  };
}

function jsonHeaders(): HeadersInit {
  return { ...authHeaders(), 'Content-Type': 'application/json' };
}

function exportedTag(text: string) {
  return {
    userId: 42,
    text,
    norm: text,
    category: 'personality',
    subject: null,
    polarity: null,
    origin: 'inferred',
    locked: false,
    status: 'confirmed',
    source: 'auto',
    samples: 2,
    evidence: [],
    firstSeen: now,
    lastSeen: now,
    updatedAt: now,
  };
}

function tagRecord(text: string, locked = false): TagRecord {
  return {
    account,
    sessionId: sessionId(groupSession),
    userId: 42,
    text,
    norm: text,
    category: 'personality',
    subject: null,
    polarity: null,
    origin: 'inferred',
    locked,
    status: 'confirmed',
    source: 'auto',
    samples: 1,
    evidence: [],
    firstSeen: now,
    lastSeen: now,
    supersededBy: null,
    updatedAt: now,
  };
}

function importFile(tags: ReturnType<typeof exportedTag>[], mode: 'merge' | 'overwrite') {
  return {
    version: 1,
    exportedAt: new Date(now).toISOString(),
    account,
    sessionId: sessionId(groupSession),
    groupName: '测试群',
    tags,
    summaries: [],
    subjects: [],
    vetoes: [],
    relations: [],
    accountKinds: [],
    mode,
  };
}

test('impressions export never includes L0 and includes L1 only on explicit request', async () => {
  await withPanel(async ({ app, repository, memberSummaryRepository }) => {
    const ownerId = 42;
    const groupId = sessionId(groupSession);
    repository.saveMessage({
      sessionId: groupId,
      messageId: 'owner-mentioned-in-group',
      senderId: ownerId,
      senderName: '主人',
      isSelf: false,
      plainText: '测试消息',
      segments: [],
      time: now,
    });
    repository.insertPrivateFact(privateFact(ownerId, 'L0', 'L0绝不导出标记'));
    repository.insertPrivateFact(privateFact(ownerId, 'L1', 'L1显式导出标记'));
    const sensitiveTag = tagRecord('SensitiveValue9001');
    sensitiveTag.evidence = [{ kind: 'message', messageId: 'sensitive-export', time: now, quote: 'SensitiveValue9001' }];
    repository.insertTag(sensitiveTag);
    const supersededTag = tagRecord('旧的替换标签');
    supersededTag.userId = 43;
    supersededTag.status = 'superseded';
    repository.insertTag(supersededTag);
    memberSummaryRepository.saveManual({ account, userId: 43, text: '仅有旧标签的摘要', updatedAt: now });

    const defaultsResponse = await app.request(
      `/api/impressions/export?sessionId=${encodeURIComponent(groupId)}`,
      { headers: authHeaders() },
    );
    assert.equal(defaultsResponse.status, 200);
    const defaults = await defaultsResponse.json() as Record<string, unknown>;
    assert.equal(JSON.stringify(defaults).includes('L0绝不导出标记'), false);
    assert.equal(JSON.stringify(defaults).includes('SensitiveValue9001'), false);
    assert.equal(JSON.stringify(defaults).includes('[敏感内容已隐藏]'), true);
    for (const field of ['tags', 'summaries', 'subjects', 'vetoes', 'relations', 'accountKinds']) {
      assert.equal(Array.isArray(defaults[field]), true, `default export includes ${field}`);
    }
    assert.equal((defaults.summaries as Array<{ userId: number }>).some((summary) => summary.userId === 43), true);
    assert.equal('activity' in defaults, false);
    assert.equal('privateFactsL1' in defaults, false);

    const l1Response = await app.request(
      `/api/impressions/export?sessionId=${encodeURIComponent(groupId)}&include=l1`,
      { headers: authHeaders() },
    );
    assert.equal(l1Response.status, 200);
    const l1Export = await l1Response.text();
    assert.equal(l1Export.includes('L1显式导出标记'), true);
    assert.equal(l1Export.includes('L0绝不导出标记'), false);

    const activityResponse = await app.request(
      `/api/impressions/export?sessionId=${encodeURIComponent(groupId)}&include=activity`,
      { headers: authHeaders() },
    );
    const activityExport = await activityResponse.json() as {
      activity: { view: string; buckets: Array<{ date: string; count: number }>; summary: { total: number } };
    };
    assert.equal(activityResponse.status, 200);
    assert.equal(activityExport.activity.view, 'year');
    assert.equal(activityExport.activity.buckets.length, 365);
    assert.equal(activityExport.activity.summary.total, 1);
    assert.equal(JSON.stringify(activityExport).includes('测试消息'), false);
  });
});

test('impressions import preview counts new tags, conflicts, vetoes, and summaries', async () => {
  await withPanel(async ({ app, repository }) => {
    const groupId = sessionId(groupSession);
    repository.insertTag({
      account,
      sessionId: groupId,
      userId: 42,
      text: '喜欢旅行',
      norm: '喜欢旅行',
      category: 'personality',
      subject: null,
      polarity: null,
      origin: 'inferred',
      locked: false,
      status: 'confirmed',
      source: 'auto',
      samples: 1,
      evidence: [],
      firstSeen: now,
      lastSeen: now,
      supersededBy: null,
      updatedAt: now,
    });
    const file = {
      version: 1,
      exportedAt: new Date(now).toISOString(),
      account,
      sessionId: groupId,
      groupName: '测试群',
      tags: [exportedTag('喜欢旅行'), exportedTag('喜欢电影')],
      summaries: [{ userId: 42, text: '喜欢旅行与电影', manual: true, updatedAt: now }],
      subjects: [],
      vetoes: [{ userId: 42, category: 'personality', subjectNorm: '', textNorm: '被否决', createdAt: now }],
      relations: [],
      accountKinds: [],
    };
    const response = await app.request('/api/impressions/import/preview', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify(file),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { added: 1, conflicts: 1, vetoes: 1, summaries: 1 });
  });
});

test('merge import preserves conflicts and adds new tags', async () => {
  await withPanel(async ({ app, repository }) => {
    const existingId = repository.insertTag(tagRecord('喜欢旅行'));
    const incoming = exportedTag('喜欢旅行');
    incoming.origin = 'manual';
    incoming.status = 'rejected';
    incoming.source = 'manual';
    incoming.samples = 9;
    const response = await app.request('/api/impressions/import', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify(importFile([incoming, exportedTag('喜欢电影')], 'merge')),
    });
    assert.equal(response.status, 200);
    const existing = repository.tagById(existingId);
    assert.equal(existing?.origin, 'inferred');
    assert.equal(existing?.source, 'auto');
    assert.equal(existing?.samples, 1);
    assert.equal(existing?.status, 'confirmed');
    assert.equal(repository.listTagsForSession(account, sessionId(groupSession)).some((tag) => tag.text === '喜欢电影'), true);
  });
});

test('overwrite import updates unlocked conflicts but leaves locked tags untouched', async () => {
  await withPanel(async ({ app, repository }) => {
    const unlockedId = repository.insertTag(tagRecord('喜欢旅行'));
    const lockedId = repository.insertTag(tagRecord('锁定标签', true));
    const unlocked = exportedTag('喜欢旅行');
    unlocked.origin = 'manual';
    unlocked.status = 'rejected';
    unlocked.source = 'manual';
    unlocked.samples = 9;
    const locked = exportedTag('锁定标签');
    locked.origin = 'manual';
    locked.status = 'rejected';
    locked.source = 'manual';
    locked.samples = 10;
    const response = await app.request('/api/impressions/import', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify(importFile([unlocked, locked], 'overwrite')),
    });
    assert.equal(response.status, 200);
    const updated = repository.tagById(unlockedId);
    assert.equal(updated?.origin, 'manual');
    assert.equal(updated?.source, 'manual');
    assert.equal(updated?.samples, 9);
    assert.equal(updated?.status, 'rejected');
    const preserved = repository.tagById(lockedId);
    assert.equal(preserved?.locked, true);
    assert.equal(preserved?.origin, 'inferred');
    assert.equal(preserved?.samples, 1);
    assert.equal(preserved?.status, 'confirmed');
  });
});

test('import preview rejects unsupported versions and groups not present in the account', async () => {
  await withPanel(async ({ app }) => {
    const file = importFile([exportedTag('喜欢旅行')], 'merge');
    const unsupported = await app.request('/api/impressions/import/preview', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ ...file, version: 2 }),
    });
    assert.equal(unsupported.status, 400);

    const missingGroup = await app.request('/api/impressions/import/preview', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ ...file, sessionId: `${account}:group:654321` }),
    });
    assert.equal(missingGroup.status, 400);
  });
});

test('import restores group vetoes, shared profiles, identities, relations, and explicit L1 facts', async () => {
  await withPanel(async ({ app, root, repository, memberSummaryRepository }) => {
    const groupId = sessionId(groupSession);
    repository.saveMessage({
      sessionId: groupId,
      messageId: 'import-owner-group-message',
      senderId: 42,
      senderName: '测试成员',
      isSelf: false,
      plainText: '测试',
      segments: [],
      time: now,
    });
    const file = {
      ...importFile([exportedTag('喜欢旅行')], 'merge'),
      summaries: [{ userId: 42, text: '喜欢旅行', manual: true, updatedAt: now }],
      subjects: [{ category: 'topic', name: '鸣潮', aliases: ['WW'] }],
      vetoes: [{ userId: 42, category: 'personality', subjectNorm: '', textNorm: '不再学习', createdAt: now }],
      relations: [{ aUserId: 42, bUserId: 43, type: 'lover', label: null, locked: true, createdAt: now }],
      accountKinds: [{ userId: 42, kind: 'human', createdAt: now }],
      privateFactsL1: [{
        ownerId: 42,
        sessionId: `${account}:private:42`,
        text: '显式导入的L1事实',
        keywords: ['导入测试', '私聊事实'],
        level: 'L1',
        levelSource: 'manual',
        mentions: 1,
        mentionEvidence: [],
        evidence: [],
        status: 'active',
        createdAt: now,
        updatedAt: now,
      }],
    };
    const response = await app.request('/api/impressions/import', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify(file),
    });
    assert.equal(response.status, 200);
    const backups = fs.readdirSync(path.join(root, 'data', 'backups'));
    assert.equal(backups.length, 1);
    const backup = JSON.parse(fs.readFileSync(path.join(root, 'data', 'backups', backups[0] ?? ''), 'utf8')) as {
      tags: unknown[];
      privateFactsL1?: unknown;
    };
    assert.equal(backup.tags.length, 0);
    assert.equal(backup.privateFactsL1, undefined);
    assert.equal(repository.listTagsForSession(account, groupId).length, 1);
    assert.equal(repository.listTagVetoes(account, groupId).length, 1);
    assert.equal(memberSummaryRepository.get(account, 42)?.text, '喜欢旅行');
    assert.equal(repository.getAccountKind(account, 42)?.kind, 'human');
    assert.equal(repository.listRelationsForUser(account, 42)[0]?.locked, true);
    const subjects = await app.request(`/api/tag-subjects/${groupId}/topic`, { headers: authHeaders() });
    assert.match(await subjects.text(), /鸣潮/);
    const facts = repository.listPrivateFactsForGroup(account, groupId);
    assert.equal(facts.filter((fact) => fact.level === 'L0').length, 0);
    assert.equal(facts.some((fact) => fact.level === 'L1'), true);
  });
});
