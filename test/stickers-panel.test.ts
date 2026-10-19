import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import type { StickerService } from '../src/core/stickers/service.ts';
import { account, authHeaders, exampleConfig, withPanel } from './panel-test-helpers.ts';

function fakeStickerService(
  upload: (dataBase64: string, filename: string) => Promise<{ synced: boolean }>,
  serviceAccount = account,
): StickerService {
  return {
    account: serviceAccount,
    async sync() {
      return { account, received: 0, inserted: 0, downloaded: 0, described: 0, markedMissing: 0, skippedByBudget: false };
    },
    async collect() { return { ok: true }; },
    upload,
    async modifyCustomFace() {},
    getLastSyncAt() { return null; },
  };
}

test('表情设置 API 支持读取、局部保存和范围校验', async () => {
  await withPanel(async ({ app, getConfig, getSavedConfig }) => {
    const current = await app.request('/api/stickers/settings', { headers: authHeaders() });
    assert.equal(current.status, 200);
    assert.deepEqual(await current.json(), exampleConfig.stickers);

    const saved = await app.request('/api/stickers/settings', {
      method: 'PATCH',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, maxRatio: 0.4 }),
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), {
      ...exampleConfig.stickers,
      enabled: true,
      maxRatio: 0.4,
    });
    assert.deepEqual(getConfig().stickers, {
      ...exampleConfig.stickers,
      enabled: true,
      maxRatio: 0.4,
    });
    assert.deepEqual(getSavedConfig()?.stickers, getConfig().stickers);
    const savedStickers = getSavedConfig()?.stickers;

    const invalid = await app.request('/api/stickers/settings', {
      method: 'PATCH',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxRatio: 1.1 }),
    });
    assert.equal(invalid.status, 400);
    assert.deepEqual(getConfig().stickers, savedStickers);
    assert.deepEqual(getSavedConfig()?.stickers, savedStickers);
  });
});

test('表情上传 API 接受大于通用请求上限的有效载荷并转交账号服务', async () => {
  const uploaded: Array<{ dataBase64: string; filename: string }> = [];
  const service = fakeStickerService(async (dataBase64, filename) => {
    uploaded.push({ dataBase64, filename });
    return { synced: true };
  });
  const otherAccountService = fakeStickerService(async () => ({ synced: true }), account + 1);
  const dataBase64 = Buffer.alloc(1_600 * 1024).toString('base64');

  await withPanel(async ({ app }) => {
    const response = await app.request(`/api/stickers/upload?account=${account}`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataBase64, filename: 'large.png' }),
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/u);
    assert.deepEqual(await response.json(), { account, synced: true });
    assert.deepEqual(uploaded, [{ dataBase64, filename: 'large.png' }]);
    const ambiguous = await app.request('/api/stickers/upload', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataBase64: 'AAAA', filename: 'small.png' }),
    });
    assert.equal(ambiguous.status, 409);
    assert.equal(uploaded.length, 1);
  }, exampleConfig.owner, { stickerServices: () => [service, otherAccountService] });
});

test('表情列表 API 返回图片地址且不泄漏本地文件名', async () => {
  const service = fakeStickerService(async () => ({ synced: true }));

  await withPanel(async ({ app, repository }) => {
    const md5 = 'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd';
    const sticker = repository.upsertSticker({ account, emojiId: 'emoji-list', md5, descQq: 'QQ' }, 10).sticker;
    repository.setStickerFile(sticker.id, `${md5}.png`, 11);

    const listed = await app.request('/api/stickers', { headers: authHeaders() });
    assert.equal(listed.status, 200);
    const listBody = await listed.json() as { stickers: Array<Record<string, unknown>> };
    assert.equal(listBody.stickers[0]?.imageUrl, `/api/stickers/${sticker.id}/image`);
    assert.equal('file' in (listBody.stickers[0] ?? {}), false);
  }, exampleConfig.owner, { stickerServices: () => [service] });
});

test('表情备注 PATCH 先写回 QQ 再读回本地描述与标签', async () => {
  const modified: Array<{ emojiId: string; desc: string }> = [];
  const service = fakeStickerService(async () => ({ synced: true }));
  service.modifyCustomFace = async (emojiId, desc) => { modified.push({ emojiId, desc }); };

  await withPanel(async ({ app, repository }) => {
    const md5 = 'cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd';
    const sticker = repository.upsertSticker({ account, emojiId: 'emoji-edit', md5, descQq: 'QQ' }, 10).sticker;
    repository.setStickerFile(sticker.id, `${md5}.png`, 11);

    const listed = await app.request('/api/stickers', { headers: authHeaders() });
    assert.equal(listed.status, 200);
    const listBody = await listed.json() as { stickers: Array<Record<string, unknown>> };
    assert.equal(listBody.stickers[0]?.imageUrl, `/api/stickers/${sticker.id}/image`);
    assert.equal('file' in (listBody.stickers[0] ?? {}), false);

    const patched = await app.request(`/api/stickers/${sticker.id}`, {
      method: 'PATCH',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false, tags: ['开心'], descAi: '开心啦' }),
    });
    assert.equal(patched.status, 200);
    assert.equal(repository.stickerById(sticker.id)?.enabled, false);
    assert.equal(repository.stickerById(sticker.id)?.descAi, '开心啦');
    assert.equal(repository.stickerById(sticker.id)?.descQq, '开心啦');
    assert.deepEqual(modified, [{ emojiId: 'emoji-edit', desc: '开心啦' }]);
  }, exampleConfig.owner, { stickerServices: () => [service] });
});

test('手动同步 API 调用目标账号服务并返回同步结果', async () => {
  let syncCount = 0;
  const service = fakeStickerService(async () => ({ synced: true }));
  service.sync = async () => {
    syncCount += 1;
    return { account, received: 1, inserted: 0, downloaded: 0, described: 0, markedMissing: 0, skippedByBudget: false };
  };

  await withPanel(async ({ app }) => {
    const synced = await app.request(`/api/stickers/sync?account=${account}`, {
      method: 'POST',
      headers: authHeaders(),
    });
    assert.equal(synced.status, 200);
    assert.deepEqual(await synced.json(), {
      results: [{ account, received: 1, inserted: 0, downloaded: 0, described: 0, markedMissing: 0, skippedByBudget: false, ok: true }],
    });
    assert.equal(syncCount, 1);
  }, exampleConfig.owner, { stickerServices: () => [service] });
});

test('表情图片接口拒绝相对目录越界的文件路径', async () => {
  await withPanel(async ({ app, database, repository, root }) => {
    const md5 = 'abababababababababababababababab';
    const sticker = repository.upsertSticker({
      account,
      emojiId: 'emoji-path-test',
      md5,
      descQq: '',
    }, 100).sticker;
    repository.setStickerFile(sticker.id, `${md5}.png`, 101);
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'outside.png'), 'outside-file-sentinel', 'utf8');
    database.prepare('UPDATE stickers SET file = ? WHERE id = ?').run('../outside.png', sticker.id);

    const response = await app.request(`/api/stickers/${sticker.id}/image`, {
      headers: authHeaders(),
    });
    const body = await response.text();

    assert.equal(response.status, 400);
    assert.doesNotMatch(body, /outside-file-sentinel/u);
  }, exampleConfig.owner, { stickerServices: () => [fakeStickerService(async () => ({ synced: false }))] });
});
