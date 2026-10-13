import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import yaml from 'yaml';
import { AquariumConfigSchema } from '../src/config/schema.ts';
import { sessionId, type IncomingMessage, type Segment, type SessionKey } from '../src/core/events.ts';
import { createMessagePipeline } from '../src/core/pipeline.ts';
import type { ProtocolAdapter } from '../src/adapters/types.ts';
import { openDatabase } from '../src/store/db.ts';
import { createRepository } from '../src/store/repository.ts';

const exampleConfig = AquariumConfigSchema.parse(yaml.parse(
  fs.readFileSync(path.resolve('config.example.yaml'), 'utf8'),
));
const session: SessionKey = { account: 900000001, kind: 'group', peer: 123456 };
const baseTime = new Date(2026, 9, 12, 9, 6).getTime();

type CapturedMessage = { role: string; content: unknown };
type CapturedRequest = { slot: string; messages: CapturedMessage[] };

function makeConfig() {
  return AquariumConfigSchema.parse({
    ...exampleConfig,
    defaults: {
      ...exampleConfig.defaults,
      enabled: true,
      nicknames: ['小鱼'],
    },
  });
}

function makeIncoming(options: {
  messageId: string;
  plainText: string;
  segments: Segment[];
  time?: number;
}): IncomingMessage {
  return {
    session,
    messageId: options.messageId,
    senderId: 42,
    senderName: '小明',
    segments: options.segments,
    plainText: options.plainText,
    mentionsSelf: false,
    replyToSelf: false,
    time: options.time ?? baseTime - 60_000,
  };
}

class FakeAdapter implements ProtocolAdapter {
  readonly account = session.account;
  readonly sent: Array<{ session: SessionKey; segments: Segment[] }> = [];
  nickname = 'Aquarium';

  async connect(): Promise<void> {}
  close(): void {}
  onMessage(): () => void { return () => {}; }
  onStatus(): () => void { return () => {}; }
  async send(messageSession: SessionKey, segments: Segment[]): Promise<{ messageId: string }> {
    this.sent.push({ session: messageSession, segments });
    return { messageId: `out-${this.sent.length}` };
  }
  async listGroups(): Promise<[]> { return []; }
  async listFriends(): Promise<[]> { return []; }
  async history(): Promise<[]> { return []; }
  async markRead(): Promise<void> {}
  async setTyping(): Promise<void> {}
  async recall(): Promise<void> {}
}

async function withRepository<T>(
  run: (repository: ReturnType<typeof createRepository>, personaRoot: string) => Promise<T>,
): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-image-pipeline-'));
  fs.mkdirSync(path.join(root, 'personas'), { recursive: true });
  fs.writeFileSync(path.join(root, 'personas', 'default.md'), '# {{name}}\n临时测试人设。', 'utf8');
  const database = openDatabase(path.join(root, 'aquarium.db'));
  try {
    return await run(createRepository(database), root);
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function createHarness(
  repository: ReturnType<typeof createRepository>,
  personaRoot: string,
  options: {
    replyText?: string;
    visionText?: string;
    visionError?: Error;
    downloadImage?: (url: string) => Promise<string>;
    onError?: (error: unknown, message: IncomingMessage) => void;
  } = {},
) {
  const adapter = new FakeAdapter();
  const requests: CapturedRequest[] = [];
  const pipeline = createMessagePipeline({
    getConfig: makeConfig,
    repository,
    adapter,
    getNickname: () => adapter.nickname,
    personaRoot,
    downloadImage: options.downloadImage ?? (async () => 'data:image/png;base64,AQID'),
    onError: options.onError,
    wait: async () => {},
    random: () => 0.4,
    callModel: async (slot, messages) => {
      requests.push({ slot, messages: messages as CapturedMessage[] });
      if (slot === 'vision' && options.visionError) throw options.visionError;
      return {
        text: slot === 'vision' ? options.visionText ?? '图片里有一只猫。' : options.replyText ?? '普通回复。',
        provider: 'deepseek',
        model: 'deepseek-flash',
        usage: { inputTokens: 12, cachedTokens: 0, outputTokens: 4, costCny: 0 },
      };
    },
    now: () => baseTime,
  });
  return { adapter, requests, pipeline };
}

test('触发消息中的图片调用 vision、按 URL 哈希缓存并替换上下文', async () => {
  await withRepository(async (repository, personaRoot) => {
    const url = 'https://example.invalid/cat.png';
    const longCaption = '窗边有一只白猫，阳光正照在它身上。'.repeat(2);
    const incoming = makeIncoming({
      messageId: 'vision-1',
      plainText: '小鱼，看这个：可爱吗？',
      segments: [
        { type: 'text', text: '小鱼，看这个：' },
        { type: 'image', url },
        { type: 'text', text: '可爱吗？' },
      ],
    });
    const downloaded: string[] = [];
    const dataUrl = 'data:image/png;base64,AQID';
    const harness = createHarness(repository, personaRoot, {
      visionText: longCaption,
      downloadImage: async (imageUrl) => {
        downloaded.push(imageUrl);
        return dataUrl;
      },
    });

    const result = await harness.pipeline(incoming);

    const key = createHash('sha1').update(url).digest('hex');
    const expectedCaption = Array.from(longCaption.trim()).slice(0, 30).join('');
    assert.deepEqual(result, { replied: true, reason: 'replied' });
    assert.deepEqual(harness.requests.map(({ slot }) => slot), ['vision', 'reply']);
    assert.deepEqual(downloaded, [url]);
    assert.equal(repository.getCaption(key), expectedCaption);
    assert.equal(Array.from(expectedCaption).length, 30);

    const visionContent = harness.requests[0]?.messages[1]?.content;
    assert.ok(Array.isArray(visionContent));
    const imagePart = visionContent.find((part) => (
      typeof part === 'object' && part !== null && 'type' in part && part.type === 'image_url'
    )) as { image_url?: { url?: string } } | undefined;
    assert.equal(imagePart?.image_url?.url, dataUrl);

    const replyPrompt = String(harness.requests[1]?.messages[1]?.content);
    assert.ok(replyPrompt.includes(`小鱼，看这个：[图片：${expectedCaption}]可爱吗？`));
  });
});

test('缓存命中的当前图片不调用 vision 或下载', async () => {
  await withRepository(async (repository, personaRoot) => {
    repository.setCaption('cached-file-1', '一只趴着的小猫');
    let downloads = 0;
    const incoming = makeIncoming({
      messageId: 'vision-cached-1',
      plainText: '小鱼，看图',
      segments: [
        { type: 'text', text: '小鱼，看图' },
        { type: 'image', url: 'https://example.invalid/cached.png', file: 'cached-file-1' },
      ],
    });
    const harness = createHarness(repository, personaRoot, {
      downloadImage: async () => {
        downloads += 1;
        return 'data:image/png;base64,AQID';
      },
    });

    const result = await harness.pipeline(incoming);

    assert.equal(result.reason, 'replied');
    assert.equal(downloads, 0);
    assert.deepEqual(harness.requests.map(({ slot }) => slot), ['reply']);
    assert.ok(String(harness.requests[0]?.messages[1]?.content).includes('[图片：一只趴着的小猫]'));
  });
});

test('一条触发消息中的每张未缓存图片都会单独描述', async () => {
  await withRepository(async (repository, personaRoot) => {
    const incoming = makeIncoming({
      messageId: 'vision-multiple-1',
      plainText: '小鱼，这两张图呢？',
      segments: [
        { type: 'text', text: '小鱼，' },
        { type: 'image', url: 'https://example.invalid/first.png', file: 'first-image' },
        { type: 'text', text: '还有' },
        { type: 'image', url: 'https://example.invalid/second.png', file: 'second-image' },
        { type: 'text', text: '呢？' },
      ],
    });
    const harness = createHarness(repository, personaRoot);

    const result = await harness.pipeline(incoming);

    assert.equal(result.reason, 'replied');
    assert.deepEqual(harness.requests.map(({ slot }) => slot), ['vision', 'vision', 'reply']);
    assert.equal(repository.getCaption('first-image'), '图片里有一只猫。');
    assert.equal(repository.getCaption('second-image'), '图片里有一只猫。');
    assert.ok(String(harness.requests[2]?.messages[1]?.content).includes(
      '小鱼，[图片：图片里有一只猫。]还有[图片：图片里有一只猫。]呢？',
    ));
  });
});

test('vision 失败时记录错误、使用图片占位并继续回复', async () => {
  await withRepository(async (repository, personaRoot) => {
    const errors: unknown[] = [];
    const incoming = makeIncoming({
      messageId: 'vision-error-1',
      plainText: '小鱼，看看',
      segments: [
        { type: 'text', text: '小鱼，看看' },
        { type: 'image', url: 'https://example.invalid/broken.png', file: 'broken-file' },
      ],
    });
    const harness = createHarness(repository, personaRoot, {
      visionError: new Error('vision unavailable'),
      onError: (error) => errors.push(error),
    });

    const result = await harness.pipeline(incoming);

    assert.deepEqual(result, { replied: true, reason: 'replied' });
    assert.deepEqual(harness.requests.map(({ slot }) => slot), ['vision', 'reply']);
    assert.equal(errors.length, 1);
    assert.ok(String(harness.requests[1]?.messages[1]?.content).includes('小鱼，看看[图片]'));
    assert.equal(repository.getCaption('broken-file'), undefined);
    assert.equal(harness.adapter.sent.length, 1);
  });
});

test('图片下载失败时不把原始链接交给 vision，并继续发送占位回复', async () => {
  await withRepository(async (repository, personaRoot) => {
    const errors: unknown[] = [];
    const incoming = makeIncoming({
      messageId: 'vision-download-error-1',
      plainText: '小鱼，看这张图',
      segments: [
        { type: 'text', text: '小鱼，看这张图' },
        { type: 'image', url: 'https://example.invalid/private.png', file: 'download-error' },
      ],
    });
    const harness = createHarness(repository, personaRoot, {
      downloadImage: async () => { throw new Error('download failed'); },
      onError: (error) => errors.push(error),
    });

    const result = await harness.pipeline(incoming);

    assert.deepEqual(result, { replied: true, reason: 'replied' });
    assert.deepEqual(harness.requests.map(({ slot }) => slot), ['reply']);
    assert.equal(errors.length, 1);
    assert.ok(String(harness.requests[0]?.messages[1]?.content).includes('小鱼，看这张图[图片]'));
    assert.equal(repository.getCaption('download-error'), undefined);
  });
});

test('不把本地图片路径作为远程 image_url 发送，并降级为图片占位', async () => {
  await withRepository(async (repository, personaRoot) => {
    const errors: unknown[] = [];
    const incoming = makeIncoming({
      messageId: 'vision-local-file-1',
      plainText: '小鱼，看图',
      segments: [
        { type: 'text', text: '小鱼，看图' },
        { type: 'image', url: 'C:\\images\\private.png', file: 'private.png' },
      ],
    });
    const harness = createHarness(repository, personaRoot, {
      onError: (error) => errors.push(error),
    });

    const result = await harness.pipeline(incoming);

    assert.equal(result.reason, 'replied');
    assert.deepEqual(harness.requests.map(({ slot }) => slot), ['reply']);
    assert.equal(errors.length, 1);
    assert.ok(String(harness.requests[0]?.messages[1]?.content).includes('小鱼，看图[图片]'));
  });
});

test('不为未触发消息识图', async () => {
  await withRepository(async (repository, personaRoot) => {
    const url = 'https://example.invalid/untriggered.png';
    const incoming = makeIncoming({
      messageId: 'vision-not-mentioned-1',
      plainText: '今晚吃什么？',
      segments: [
        { type: 'text', text: '今晚吃什么？' },
        { type: 'image', url },
      ],
    });
    const harness = createHarness(repository, personaRoot);

    const result = await harness.pipeline(incoming);

    assert.deepEqual(result, { replied: false, reason: 'not_mentioned' });
    assert.equal(harness.requests.length, 0);
    assert.equal(repository.getCaption(createHash('sha1').update(url).digest('hex')), undefined);
  });
});

test('历史图片只使用缓存描述，未缓存图片显示通用占位', async () => {
  await withRepository(async (repository, personaRoot) => {
    repository.setCaption('history-cached-file', '缓存中的红色风筝');
    repository.saveMessage({
      sessionId: sessionId(session),
      messageId: 'history-image-cached',
      senderId: 9,
      senderName: '小明',
      isSelf: false,
      plainText: '看这个',
      segments: [
        { type: 'text', text: '看这个' },
        { type: 'image', url: 'https://example.invalid/history-cached.png', file: 'history-cached-file' },
      ],
      time: baseTime - 120_000,
    });
    repository.saveMessage({
      sessionId: sessionId(session),
      messageId: 'history-image-missing',
      senderId: 10,
      senderName: '小红',
      isSelf: false,
      plainText: '还有一张',
      segments: [
        { type: 'text', text: '还有一张' },
        { type: 'image', url: 'https://example.invalid/history-missing.png' },
      ],
      time: baseTime - 90_000,
    });
    const incoming = makeIncoming({
      messageId: 'history-trigger',
      plainText: '小鱼，早上好',
      segments: [{ type: 'text', text: '小鱼，早上好' }],
      time: baseTime - 60_000,
    });
    const harness = createHarness(repository, personaRoot);

    const result = await harness.pipeline(incoming);

    assert.equal(result.reason, 'replied');
    assert.deepEqual(harness.requests.map(({ slot }) => slot), ['reply']);
    const prompt = String(harness.requests[0]?.messages[1]?.content);
    assert.ok(prompt.includes('看这个[图片：缓存中的红色风筝]'));
    assert.ok(prompt.includes('还有一张[图片]'));
  });
});
