import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import yaml from 'yaml';
import type OpenAI from 'openai';
import { AquariumConfigSchema } from '../src/config/schema.ts';
import { promptTemplateStore } from '../src/core/prompt-templates.ts';
import { createAccountStickerService } from '../src/app/stickers.ts';
import { openDatabase } from '../src/store/db.ts';
import { createRepository } from '../src/store/repository.ts';
import { OneBotAdapter } from '../src/adapters/onebot/adapter.ts';
import { account, createFakeClient, createFixture } from './onebot-adapter-test-helpers.ts';

const exampleConfig = AquariumConfigSchema.parse(yaml.parse(
  fs.readFileSync(path.resolve('config.example.yaml'), 'utf8'),
));

test('表情描述经 vision 槽位注入模板与图片并记录用量', async (t) => {
  const snowLumaRoot = createFixture(t, [{ host: '127.0.0.1', port: 3001 }]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-sticker-vision-'));
  const database = openDatabase(path.join(root, 'aquarium.db'));
  const repository = createRepository(database);
  const fake = createFakeClient();
  fake.state.rawResults.set('fetch_custom_face_detail', [{
    emoji_id: 'emoji-vision',
    resId: 'res-vision',
    url: 'https://gchat.qpic.cn/vision.png',
    md5: '12121212121212121212121212121212',
    desc: '',
  }]);
  const adapter = new OneBotAdapter({ account, snowlumaDir: snowLumaRoot }, () => fake.client);
  t.after(() => {
    adapter.close();
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await adapter.connect();
  const config = AquariumConfigSchema.parse({
    ...exampleConfig,
    budget: { ...exampleConfig.budget, dailyCny: 100 },
  });
  const dataUrl = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')}`;
  const usageTime = Date.now();
  let capturedMessages: OpenAI.ChatCompletionMessageParam[] | undefined;
  let capturedAccount: number | undefined;
  const service = createAccountStickerService({
    adapter,
    root,
    repository,
    getConfig: () => config,
    getPromptTemplate: () => promptTemplateStore.get().stickerDescribe,
    downloadImage: async () => dataUrl,
    callVision: async (messages, options) => {
      capturedMessages = messages;
      capturedAccount = options.account;
      options.recordUsage({
        time: usageTime,
        account: options.account,
        slot: 'vision',
        provider: 'fake',
        model: 'fake-vision',
        inputTokens: 4,
        cachedTokens: 0,
        outputTokens: 2,
        costCny: 0,
        latencyMs: 1,
        ok: true,
      });
      return {
        text: '{"desc":"开心啦","tags":["开心"]}',
        provider: 'fake',
        model: 'fake-vision',
        usage: { inputTokens: 4, cachedTokens: 0, outputTokens: 2, costCny: 0 },
        params: {},
      };
    },
  });

  await service.sync();

  const template = promptTemplateStore.get().stickerDescribe;
  assert.equal(capturedAccount, account);
  assert.equal(capturedMessages?.[0]?.role, 'system');
  assert.equal(capturedMessages?.[0]?.content, template.system);
  const userContent = capturedMessages?.[1]?.content;
  assert.ok(Array.isArray(userContent));
  assert.deepEqual(userContent[0], { type: 'text', text: template.user });
  assert.deepEqual(userContent[1], { type: 'image_url', image_url: { url: dataUrl } });
  assert.equal(repository.usageToday().requestCount, 1);
  assert.equal(repository.listStickers(account)[0]?.descAi, '开心啦');
});
