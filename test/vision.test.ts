import assert from 'node:assert/strict';
import test from 'node:test';
import type { IncomingMessage, Segment } from '../src/core/shared/events.ts';
import { captionIncomingImages, messageTextWithImageCaptions } from '../src/core/images/index.ts';
import type { MessageStorageRecord } from '../src/store/repository.ts';
import { groupSession, withRepository } from './pipeline-test-helpers.ts';

const dataUrl = 'data:image/png;base64,AQID';

function visionTemplate(version: string) {
  return { source: '', version, system: '识别图片', user: '识别图片中的内容' };
}

function visionResult(text: string) {
  return {
    text,
    provider: 'fake',
    model: 'fake-vision',
    usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
  };
}

function imageRecords(url: string, subType?: number): { incoming: IncomingMessage; stored: MessageStorageRecord } {
  const image = {
    type: 'image' as const,
    url,
    ...(subType === undefined ? {} : { subType }),
  } as unknown as Segment;
  const incoming: IncomingMessage = {
    session: groupSession,
    messageId: `image-${subType ?? 'normal'}`,
    senderId: 42,
    senderName: '小明',
    segments: [{ type: 'text', text: '看图' }, image],
    plainText: '看图',
    mentionsSelf: false,
    replyToSelf: false,
    time: 1_700_000_000_000,
  };
  const stored: MessageStorageRecord = {
    sessionId: '900000001:group:123456',
    messageId: incoming.messageId,
    senderId: incoming.senderId,
    senderName: incoming.senderName,
    isSelf: false,
    plainText: incoming.plainText,
    segments: incoming.segments,
    time: incoming.time,
  };
  return { incoming, stored };
}

async function caption(
  incoming: IncomingMessage,
  repository: Parameters<Parameters<typeof withRepository>[0]>[0],
  version: string,
  response: () => string | Promise<string>,
): Promise<void> {
  await captionIncomingImages({
    message: incoming,
    repository,
    callVision: async () => visionResult(await response()),
    visionTemplate: visionTemplate(version),
    downloadImage: async () => dataUrl,
    now: () => 1_700_000_000_000,
  });
}

test('vision JSON 逐字转写截图文字并按 kind 渲染', async () => {
  await withRepository(async (repository) => {
    const { incoming, stored } = imageRecords('https://example.invalid/screenshot.png');

    await caption(incoming, repository, 'vision-v1', () => JSON.stringify({
      kind: 'screenshot',
      desc: '聊天窗口',
      text: '你好，世界',
      legible: true,
    }));

    assert.equal(
      messageTextWithImageCaptions(stored, repository, 'vision-v1'),
      '看图[截图：聊天窗口｜文字：“你好，世界”]',
    );
  });
});

test('vision 解析失败时原样保留响应文本作为描述以兼容旧输出', async () => {
  await withRepository(async (repository) => {
    const { incoming, stored } = imageRecords('https://example.invalid/legacy.png');
    const rawResponse = '  原始文本\n第二行  ';

    await caption(incoming, repository, 'vision-v1', () => rawResponse);

    assert.equal(
      messageTextWithImageCaptions(stored, repository, 'vision-v1'),
      `看图[图片：${rawResponse}]`,
    );
  });
});

test('QQ sub_type=1 强制渲染为表情包，空文字省略后半部分', async () => {
  await withRepository(async (repository) => {
    const { incoming, stored } = imageRecords('https://example.invalid/sticker.gif', 1);
    assert.equal(messageTextWithImageCaptions(stored, repository, 'vision-v1'), '看图[表情包]');

    await caption(incoming, repository, 'vision-v1', () => JSON.stringify({
      kind: 'photo',
      desc: '笑脸表情',
      text: '',
      legible: true,
    }));

    assert.equal(messageTextWithImageCaptions(stored, repository, 'vision-v1'), '看图[表情包：笑脸表情]');
  });
});

test('vision 缓存按模板版本隔离', async () => {
  await withRepository(async (repository) => {
    const { incoming, stored } = imageRecords('https://example.invalid/reused.png');
    let calls = 0;
    const response = () => JSON.stringify({
      kind: 'photo',
      desc: `描述版本${++calls}`,
      text: '',
      legible: true,
    });

    await caption(incoming, repository, 'vision-v1', response);
    await caption(incoming, repository, 'vision-v1', response);
    assert.equal(calls, 1);
    assert.equal(messageTextWithImageCaptions(stored, repository, 'vision-v1'), '看图[图片：描述版本1]');

    await caption(incoming, repository, 'vision-v2', response);
    assert.equal(calls, 2);
    assert.equal(messageTextWithImageCaptions(stored, repository, 'vision-v2'), '看图[图片：描述版本2]');
  });
});
