import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionId, type IncomingMessage, type Segment } from '../src/core/shared/events.ts';
import { captionIncomingImages, messageTextWithImageCaptions } from '../src/core/images/index.ts';
import type { ImageCaptionRecord } from '../src/store/repository.ts';
import { computeImageMd5 } from '../src/core/images/fingerprint.ts';
import { onePixelGif } from './gif-fixtures.ts';
import { groupSession, withRepository } from './pipeline-test-helpers.ts';

const visionModel = 'vision-model-a';
const templateVersion = 'vision-template-a';
const template = { source: '', version: templateVersion, system: 'vision JSON', user: 'read image' };
const pngDataUrl = 'data:image/png;base64,YWJj';

function makeMessage(segments: Segment[], messageId: string): IncomingMessage {
  return {
    session: groupSession,
    messageId,
    senderId: 42,
    senderName: '小明',
    segments,
    plainText: segments.filter((segment) => segment.type === 'text').map((segment) => segment.text).join(''),
    mentionsSelf: false,
    replyToSelf: false,
    time: 1_700_000_000_000,
  };
}

function jsonResult(values: { kind: string; desc: string; text: string; legible: boolean }) {
  return {
    text: JSON.stringify(values),
    provider: 'fake',
    model: 'fake-vision',
    usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
  };
}

async function caption(
  message: IncomingMessage,
  repository: Parameters<Parameters<typeof withRepository>[0]>[0],
  responses: Array<ReturnType<typeof jsonResult>>,
  overrides: { model?: string; version?: string; downloadImage?: () => Promise<string> } = {},
): Promise<{ calls: number; requests: unknown[][] }> {
  let calls = 0;
  const requests: unknown[][] = [];
  await captionIncomingImages({
    message,
    repository,
    visionModel: overrides.model ?? visionModel,
    visionTemplate: { ...template, version: overrides.version ?? templateVersion },
    callVision: async (messages) => {
      requests.push(messages as unknown[]);
      const response = responses[calls];
      calls += 1;
      if (!response) throw new Error('unexpected vision call');
      return response;
    },
    downloadImage: overrides.downloadImage ?? (async () => pngDataUrl),
    now: () => 1_700_000_000_000,
  });
  return { calls, requests };
}

function imageRecord(md5: string, patch: Partial<ImageCaptionRecord> = {}): ImageCaptionRecord {
  return {
    md5,
    caption: '[图片：缓存描述]',
    kind: 'photo',
    desc: '缓存描述',
    text: '',
    legible: true,
    visionModel,
    visionTemplateVersion: templateVersion,
    time: 1_700_000_000_000,
    ...patch,
  };
}

test('商城表情 summary 直接作为含义，不调用 vision', async () => {
  await withRepository(async (repository) => {
    const message = makeMessage([
      { type: 'text', text: '看这个' },
      { type: 'sticker', emojiId: 'market-emoji', summary: '[动画表情]' },
    ], 'market-summary');
    const result = await caption(message, repository, []);

    assert.equal(result.calls, 0);
    assert.equal(messageTextWithImageCaptions({
      sessionId: '900000001:group:123456', messageId: message.messageId, senderId: 42,
      senderName: '小明', isSelf: false, plainText: '看这个', segments: message.segments, time: message.time,
    }, repository, templateVersion, visionModel), '看这个[动画表情]');
  });
});

test('QQ sub_type=1 覆盖相同 MD5 缓存中的非表情分类', async () => {
  await withRepository(async (repository) => {
    const md5 = 'd'.repeat(32);
    repository.setImageCaption(imageRecord(md5, {
      kind: 'photo',
      desc: '笑脸表情',
      text: '好耶',
      caption: '[图片：笑脸表情｜图上写着“好耶”]',
    }));
    const message = makeMessage([
      { type: 'text', text: '看图' },
      { type: 'image', url: 'https://example.invalid/qq-sticker.png', file: `${md5}.png`, subType: 1 },
    ], 'cached-qq-sticker');

    const result = await caption(message, repository, []);

    assert.equal(result.calls, 0);
    assert.equal(messageTextWithImageCaptions({
      sessionId: '900000001:group:123456', messageId: message.messageId, senderId: 42,
      senderName: '小明', isSelf: false, plainText: '看图', segments: message.segments, time: message.time,
    }, repository, templateVersion, visionModel), '看图[表情包：笑脸表情｜图上写着“好耶”]');
  });
});

test('图片 md5 命中表情库时按 manual、desc_ai、desc_qq 优先级取描述', async () => {
  await withRepository(async (repository) => {
    const manualMd5 = 'a'.repeat(32);
    const aiMd5 = 'b'.repeat(32);
    const manual = repository.upsertSticker({ account: groupSession.account, emojiId: 'manual', md5: manualMd5, descQq: 'QQ 描述' }, 1).sticker;
    repository.saveStickerDescription(manual.id, 'AI 描述', [], 2);
    repository.updateSticker(manual.id, { descAi: '手动描述' }, 3);
    repository.setImageCaption(imageRecord(manualMd5, {
      caption: '[图片：低优先级缓存]',
      desc: '低优先级缓存',
    }));
    const ai = repository.upsertSticker({ account: groupSession.account, emojiId: 'ai', md5: aiMd5, descQq: 'QQ 描述' }, 1).sticker;
    repository.saveStickerDescription(ai.id, 'AI 描述', [], 2);
    const message = makeMessage([
      { type: 'text', text: '图' },
      {
        type: 'image',
        url: 'https://example.invalid/manual.png',
        file: `${manualMd5}.png`,
        md5: 'c'.repeat(32),
      },
      { type: 'image', url: 'https://example.invalid/ai.png', file: `${aiMd5}.png` },
    ], 'sticker-lookup');

    const result = await caption(message, repository, [], {
      downloadImage: async () => { throw new Error('a sticker row should avoid download'); },
    });

    assert.equal(result.calls, 0);
    const text = messageTextWithImageCaptions({
      sessionId: '900000001:group:123456', messageId: message.messageId, senderId: 42,
      senderName: '小明', isSelf: false, plainText: '图', segments: message.segments, time: message.time,
    }, repository, templateVersion, visionModel);
    assert.equal(text, '图[表情包：手动描述][表情包：AI 描述]');
  });
});

test('图片认知缓存按 MD5 读取，模型或模板变化时重新识别', async () => {
  await withRepository(async (repository) => {
    const md5 = 'c'.repeat(32);
    const message = makeMessage([
      { type: 'text', text: '看图' },
      { type: 'image', url: 'https://example.invalid/cache.png', file: `${md5}.png` },
    ], 'cache-version');
    let sequence = 0;
    const response = () => jsonResult({
      kind: 'photo', desc: `版本${++sequence}`, text: '', legible: true,
    });

    await caption(message, repository, [response()]);
    await caption(message, repository, [response()]);
    await caption(message, repository, [response()], { version: 'vision-template-b' });
    await caption(message, repository, [response()], { version: 'vision-template-b', model: 'vision-model-b' });

    assert.equal(sequence, 4);
    const stored = repository.getImageCaption(md5);
    assert.equal(stored?.visionModel, 'vision-model-b');
    assert.equal(stored?.visionTemplateVersion, 'vision-template-b');
    assert.equal(stored?.desc, '版本4');
  });
});

test('无 MD5 文件名时从下载内容计算 MD5 并缓存描述', async () => {
  await withRepository(async (repository) => {
    const message = makeMessage([
      { type: 'text', text: '看图' },
      { type: 'image', url: 'https://example.invalid/no-hash.png', file: 'image.png' },
    ], 'computed-md5');
    repository.saveMessage({
      sessionId: sessionId(groupSession),
      messageId: message.messageId,
      senderId: message.senderId,
      senderName: message.senderName,
      isSelf: false,
      plainText: message.plainText,
      segments: message.segments,
      time: message.time,
    });
    const md5 = computeImageMd5(Buffer.from('abc'));
    await caption(message, repository, [jsonResult({
      kind: 'screenshot', desc: '窗口', text: '精确文字', legible: true,
    })]);

    assert.equal(message.segments[1]?.type === 'image' ? message.segments[1].md5 : undefined, md5);
    const stored = repository.messageBySessionAndId(sessionId(groupSession), message.messageId);
    const storedImage = stored?.segments[1] as { md5?: string } | undefined;
    assert.equal(storedImage?.md5, md5);
    assert.equal(repository.getImageCaption(md5)?.text, '精确文字');
  });
});

test('GIF 中 sticker 文字为空会逐帧重试，并使用第二次可读结果', async () => {
  await withRepository(async (repository) => {
    const bytes = Buffer.from(onePixelGif([0, 1, 2, 3]));
    const message = makeMessage([
      { type: 'text', text: '看动图' },
      { type: 'image', url: 'https://example.invalid/moving.gif', file: 'moving.gif' },
    ], 'gif-sticker-retry');
    const result = await caption(message, repository, [
      jsonResult({ kind: 'sticker', desc: '表情', text: '', legible: true }),
      jsonResult({ kind: 'sticker', desc: '表情', text: '好耶', legible: true }),
    ], { downloadImage: async () => `data:image/gif;base64,${bytes.toString('base64')}` });

    assert.equal(result.calls, 2);
    const imageCount = (request: unknown[]) => {
      const user = request[1] as { content: Array<{ type: string }> };
      return user.content.filter(({ type }) => type === 'image_url').length;
    };
    assert.deepEqual(result.requests.map(imageCount), [1, 4]);
    const md5 = computeImageMd5(bytes);
    assert.equal(repository.getImageCaption(md5)?.caption, '[表情包：表情｜图上写着“好耶”]');
  });
});

test('GIF 两次仍读不清时清空文字、注明并缓存，不再重试', async () => {
  await withRepository(async (repository) => {
    const bytes = Buffer.from(onePixelGif([0, 1, 2, 3]));
    const message = makeMessage([
      { type: 'text', text: '看动图' },
      { type: 'image', url: 'https://example.invalid/unclear.gif', file: 'unclear.gif' },
    ], 'gif-unreadable');
    const dataUrl = `data:image/gif;base64,${bytes.toString('base64')}`;
    let modelCalls = 0;
    const responses = [
      jsonResult({ kind: 'screenshot', desc: '消息界面', text: '', legible: false }),
      jsonResult({ kind: 'screenshot', desc: '消息界面', text: '猜测文字', legible: false }),
    ];
    const options = {
      visionModel,
      visionTemplate: template,
      callVision: async () => responses[modelCalls++]!,
      downloadImage: async () => dataUrl,
      now: () => 1_700_000_000_000,
    };

    await captionIncomingImages({ message, repository, ...options });
    await captionIncomingImages({ message, repository, ...options });

    const md5 = computeImageMd5(bytes);
    const stored = repository.getImageCaption(md5);
    assert.equal(modelCalls, 2);
    assert.equal(stored?.text, '');
    assert.equal(stored?.desc, '消息界面，文字看不清');
    assert.equal(stored?.caption, '[截图：消息界面，文字看不清]');
  });
});
