import assert from 'node:assert/strict';
import test from 'node:test';
import { createPanelApp } from '../src/panel-server/app.ts';
import { sessionId } from '../src/core/shared/events.ts';
import { openDatabase } from '../src/store/db.ts';
import { createRepository } from '../src/store/repository.ts';
import { createTagSubjectRepository } from '../src/store/tag-subject-repo.ts';
import { makeConfig } from './pipeline-test-helpers.ts';

const password = 'test-panel-password';
const headers = { Authorization: `Bearer ${password}` };
const jsonHeaders = { ...headers, 'Content-Type': 'application/json' };

test('成分别名 API 可读写、规范化并拒绝跨 subject 冲突', async () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    const tagSubjects = createTagSubjectRepository(database);
    const config = makeConfig();
    const app = createPanelApp({
      password,
      getConfig: () => config,
      saveConfig: () => {},
      repository,
      accounts: () => [],
      management: () => [],
      tagSubjects,
    });
    const groupId = sessionId({ account: config.accounts[0]!.uin, kind: 'group', peer: 99123 });
    const endpoint = `/api/tag-subjects/${encodeURIComponent(groupId)}/fandom`;

    assert.equal((await app.request(endpoint)).status, 401);
    const save = await app.request(endpoint, {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({ name: 'CS2', aliases: ['CSGO', '反恐精英', 'cs'] }),
    });
    assert.equal(save.status, 200);
    assert.deepEqual(await save.json(), {
      id: 1,
      account: config.accounts[0]!.uin,
      category: 'fandom',
      name: 'CS2',
      aliases: ['CSGO', '反恐精英', 'cs'],
    });

    const read = await app.request(endpoint, { headers });
    assert.equal(read.status, 200);
    assert.deepEqual(await read.json(), [{
      id: 1,
      account: config.accounts[0]!.uin,
      category: 'fandom',
      name: 'CS2',
      aliases: ['CSGO', '反恐精英', 'cs'],
    }]);

    const conflict = await app.request(endpoint, {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({ name: '射击游戏', aliases: ['csgo'] }),
    });
    assert.equal(conflict.status, 409);
    assert.deepEqual(tagSubjects.listTagSubjects(config.accounts[0]!.uin, 'fandom').map(({ name }) => name), ['CS2']);
  } finally {
    database.close();
  }
});

test('凭据样式的成分别名拒绝写入并在历史数据读取时遮蔽', async () => {
  const database = openDatabase(':memory:');
  try {
    const repository = createRepository(database);
    const tagSubjects = createTagSubjectRepository(database);
    const config = makeConfig();
    const app = createPanelApp({
      password,
      getConfig: () => config,
      saveConfig: () => {},
      repository,
      accounts: () => [],
      management: () => [],
      tagSubjects,
    });
    const accountId = config.accounts[0]!.uin;
    const groupId = sessionId({ account: accountId, kind: 'group', peer: 99123 });
    const endpoint = `/api/tag-subjects/${encodeURIComponent(groupId)}/fandom`;
    const fakeName = ['K9m4R2p8', 'T1v6'].join('');
    const fakeAlias = ['A4b7N2c9', 'D5p1'].join('');
    tagSubjects.saveTagSubject({ account: accountId, category: 'fandom', name: fakeName, aliases: [fakeAlias] });

    const read = await app.request(endpoint, { headers });
    const body = await read.text();
    assert.equal(read.status, 200);
    assert.equal(body.includes(fakeName), false);
    assert.equal(body.includes(fakeAlias), false);
    assert.equal(body.split('[敏感内容已隐藏]').length - 1, 2);

    const write = await app.request(endpoint, {
      method: 'PUT',
      headers: jsonHeaders,
      body: JSON.stringify({ name: '安全成分', aliases: [fakeAlias] }),
    });
    assert.equal(write.status, 400);
  } finally {
    database.close();
  }
});
