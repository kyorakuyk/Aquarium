import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { sessionId } from '../src/core/shared/events.ts';
import type { TagRecord } from '../src/store/affect-repo.ts';
import { account, authHeaders, groupSession, now, withPanel } from './panel-test-helpers.ts';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

function tag(session: string, userId: number | null, text: string, category: TagRecord['category']): TagRecord {
  return {
    account,
    sessionId: session,
    userId,
    text,
    norm: text,
    category,
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
    supersededBy: null,
    updatedAt: now,
  };
}

test('group injection explains authorized shared sources when the local category list is empty', async () => {
  const groupProfile = read('../panel/src/components/GroupProfileCard.tsx');
  assert.match(groupProfile, /这行来自回复提示词的「群知识」段/u);
  assert.match(groupProfile, /同眷属其他账号/u);
  assert.match(groupProfile, /经隐私策略授权/u);
  assert.match(groupProfile, /个人印象属于另一段提示词/u);

  await withPanel(async ({ app, repository }) => {
    const sourceAccount = account + 100;
    const sourceGroup = sessionId({ account: sourceAccount, kind: 'group', peer: 98765 });
    const kinGroupId = repository.createKinGroup('共享群事实');
    repository.setKinGroupMembers(kinGroupId, [account, sourceAccount]);
    repository.insertTag({
      ...tag(sourceGroup, null, '共享群聊事实', 'positioning'),
      account: sourceAccount,
      kind: 'fact',
    });

    const targetGroup = sessionId(groupSession);
    const response = await app.request(`/api/impressions/${encodeURIComponent(targetGroup)}`, {
      headers: authHeaders(),
    });
    assert.equal(response.status, 200);
    const view = await response.json() as { groupTags: unknown[]; groupTagsText: string | null };
    assert.deepEqual(view.groupTags, []);
    assert.match(view.groupTagsText ?? '', /共享群聊事实/u);
  });
});
