import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import yaml from 'yaml';
import { AquariumConfigSchema } from '../src/config/schema.ts';
import { sessionId, type IncomingMessage, type SessionKey } from '../src/core/events.ts';
import { createStickerService, type StickerAdapter } from '../src/core/stickers/service.ts';
import { openDatabase } from '../src/store/db.ts';
import { createRepository } from '../src/store/repository.ts';

const exampleConfig = AquariumConfigSchema.parse(yaml.parse(
  fs.readFileSync(path.resolve('config.example.yaml'), 'utf8'),
));
const account = exampleConfig.accounts[0]?.uin ?? 10001;
const session: SessionKey = { account, kind: 'group', peer: 123456 };
const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const imageDataUrl = `data:image/png;base64,${imageBytes.toString('base64')}`;

function withStickerService<T>(run: (value: {
  root: string;
  dataDirectory: string;
  repository: ReturnType<typeof createRepository>;
}) => Promise<T>): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-stickers-'));
  const database = openDatabase(path.join(root, 'aquarium.db'));
  const dataDirectory = path.join(root, 'data', 'stickers');
  try {
    return run({ root, dataDirectory, repository: createRepository(database) }).finally(() => {
      database.close();
      fs.rmSync(root, { recursive: true, force: true });
    });
  } catch (error) {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function incoming(messageId: string, segments: IncomingMessage['segments'], plainText: string): IncomingMessage {
  return {
    session,
    messageId,
    senderId: 9001,
    senderName: '主人',
    segments,
    plainText,
    mentionsSelf: false,
    replyToSelf: false,
    time: 1_800_000_000_000,
  };
}

function detail(md5: string, emojiId = `emoji-${md5.slice(0, 4)}`) {
  return {
    emojiId,
    resId: `res-${md5.slice(0, 4)}`,
    url: `https://gchat.qpic.cn/${md5}.png`,
    md5,
    desc: 'QQ 备注',
  };
}

function customFaceAdapter(fetchDetails: () => Promise<ReturnType<typeof detail>[]>) {
  const additions: string[] = [];
  const imageLookups: string[] = [];
  const adapter: StickerAdapter = {
    async fetchDetails(count) {
      assert.equal(count, 300);
      return fetchDetails();
    },
    async addCustomFace(file) {
      additions.push(file);
      return { emojiId: 'added-emoji' };
    },
    async modifyCustomFace() {},
    async getImageUrl(file) {
      imageLookups.push(file);
      return 'https://gchat.qpic.cn/refreshed.png';
    },
  };
  return { adapter, additions, imageLookups };
}

test('同步按账号与 md5 去重、保留相对图片文件并标记已移除表情', async () => {
  await withStickerService(async ({ dataDirectory, repository }) => {
    const md5A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const md5B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    let remote = [detail(md5A), detail(md5A, 'emoji-a-new'), detail(md5B)];
    const downloaded: string[] = [];
    const { adapter } = customFaceAdapter(async () => remote);
    const config = AquariumConfigSchema.parse({
      ...exampleConfig,
      budget: { ...exampleConfig.budget, dailyCny: 0 },
    });
    const service = createStickerService({
      account,
      adapter,
      repository,
      dataDirectory,
      getConfig: () => config,
      downloadImage: async (url) => { downloaded.push(url); return imageDataUrl.replace('image/png', 'image/gif'); },
      describeImage: async () => { throw new Error('预算超限时不应描述'); },
      now: () => 1_000,
    });

    await service.sync();
    let records = repository.listStickers(account);
    assert.equal(records.length, 2);
    assert.deepEqual(records.map((record) => record.md5), [md5A, md5B]);
    assert.equal(records[0]?.emojiId, 'emoji-a-new');
    assert.equal(records[0]?.file, `${md5A}.png`);
    assert.equal(path.isAbsolute(records[0]?.file ?? ''), false);
    assert.equal(records[1]?.file, `${md5B}.png`);
    assert.equal(downloaded.length, 2);
    assert.equal(fs.existsSync(path.join(dataDirectory, `${md5A}.png`)), true);

    remote = [detail(md5A)];
    await service.sync();
    records = repository.listStickers(account);
    assert.equal(records.find((record) => record.md5 === md5A)?.missing, false);
    assert.equal(records.find((record) => record.md5 === md5B)?.missing, true);
    assert.equal(downloaded.length, 2);
  });
});

test('描述 JSON 校验失败最多重试三次，合法描述与标签落库', async () => {
  await withStickerService(async ({ dataDirectory, repository }) => {
    const md5A = 'cccccccccccccccccccccccccccccccc';
    const md5B = 'dddddddddddddddddddddddddddddddd';
    const { adapter } = customFaceAdapter(async () => [detail(md5A), detail(md5B)]);
    const config = AquariumConfigSchema.parse({
      ...exampleConfig,
      budget: { ...exampleConfig.budget, dailyCny: 100 },
    });
    const responses = [
      'not json',
      '{"desc":"开心啦","tags":["开心","撒娇"]}',
      '{"desc":"错误","tags":["x"]}',
      'not json',
    ];
    let calls = 0;
    const service = createStickerService({
      account,
      adapter,
      repository,
      dataDirectory,
      getConfig: () => config,
      downloadImage: async () => imageDataUrl,
      describeImage: async () => { calls += 1; return responses.shift() ?? 'unexpected'; },
      now: () => 2_000 + calls,
    });

    await service.sync();
    await service.sync();
    await service.sync();
    await service.sync();

    const records = repository.listStickers(account);
    const failed = records.find((record) => record.md5 === md5A);
    const described = records.find((record) => record.md5 === md5B);
    assert.equal(calls, 4);
    assert.equal(failed?.descriptionAttempts, 3);
    assert.equal(failed?.descAi, '');
    assert.equal(described?.descriptionAttempts, 1);
    assert.equal(described?.descAi, '开心啦');
    assert.deepEqual(described?.tags, ['开心', '撒娇']);
  });
});

test('收藏回复在图片 URL 过期时用 get_image 刷新并写入 QQ 收藏', async () => {
  await withStickerService(async ({ dataDirectory, repository }) => {
    const md5 = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const sourceMessageId = 'source-image';
    repository.saveMessage({
      sessionId: sessionId(session),
      messageId: sourceMessageId,
      senderId: 42,
      senderName: '群友',
      isSelf: false,
      plainText: '',
      segments: [{ type: 'image', url: 'https://gchat.qpic.cn/expired.png', file: 'file-1' }],
      time: 10,
    });
    const events: string[] = [];
    const { adapter, additions, imageLookups } = customFaceAdapter(async () => {
      events.push('sync');
      return [detail(md5, 'added-emoji')];
    });
    const config = AquariumConfigSchema.parse({
      ...exampleConfig,
      budget: { ...exampleConfig.budget, dailyCny: 0 },
    });
    const service = createStickerService({
      account,
      adapter,
      repository,
      dataDirectory,
      getConfig: () => config,
      downloadImage: async (url) => {
        if (url.includes('expired')) throw new Error('expired image URL');
        return imageDataUrl;
      },
      describeImage: async () => { throw new Error('预算超限时不应描述'); },
      now: () => 3_000,
    });
    const result = await service.collect(incoming('collect-message', [
      { type: 'reply', messageId: sourceMessageId },
      { type: 'text', text: '收藏' },
    ], '收藏'));

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(imageLookups, ['file-1']);
    assert.equal(additions.length, 1);
    assert.ok(additions[0]?.startsWith('base64://'));
    assert.equal(events[0], 'sync');
    assert.equal(repository.listStickers(account)[0]?.file, `${md5}.png`);
  });
});

test('上传校验内容与文件名后以 base64 调用 add_custom_face 并同步', async () => {
  await withStickerService(async ({ dataDirectory, repository }) => {
    const md5 = 'ffffffffffffffffffffffffffffffff';
    const events: string[] = [];
    const { adapter, additions } = customFaceAdapter(async () => {
      events.push('sync');
      return [detail(md5, 'uploaded-emoji')];
    });
    const config = AquariumConfigSchema.parse({
      ...exampleConfig,
      budget: { ...exampleConfig.budget, dailyCny: 0 },
    });
    const service = createStickerService({
      account,
      adapter,
      repository,
      dataDirectory,
      getConfig: () => config,
      downloadImage: async () => imageDataUrl,
      describeImage: async () => { throw new Error('预算超限时不应描述'); },
      now: () => 4_000,
    });

    const uploaded = await service.upload(imageBytes.toString('base64'), 'upload.png');
    assert.deepEqual(uploaded, { synced: true });
    assert.deepEqual(additions, [`base64://${imageBytes.toString('base64')}`]);
    assert.deepEqual(events, ['sync']);
    assert.equal(repository.listStickers(account)[0]?.md5, md5);
    await assert.rejects(service.upload('invalid-base64', 'upload.png'), /Base64/u);
    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64');
    await assert.rejects(service.upload(oversized, 'oversized.png'), /5 MiB/u);
  });
});
