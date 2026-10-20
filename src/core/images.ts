import type OpenAI from 'openai';
import { sessionId, type IncomingMessage, type Segment } from './events.ts';
import type { ImageCaptionRecord, MessageStorageRecord, StoreRepository } from '../store/repository.ts';
import type { SlotResult } from '../llm/slots.ts';
import type { VisionPromptTemplate } from './prompt-templates.ts';
import { computeImageMd5, imageBytesFromDataUrl, imageMd5FromFile } from './images/fingerprint.ts';
import { decodeGifFrames, selectGifFrames } from './images/gif.ts';
import { createGifMontage, encodePng } from './images/png.ts';
import {
  parseVisionDescription,
  renderVisionDescription,
  withUnreadableText,
  type VisionDescription,
} from './images/description.ts';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 10_000;
const SUPPORTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const ALLOWED_IMAGE_HOST_SUFFIXES = ['qq.com.cn', 'qq.com', 'qpic.cn'];

type ImageSegment = Extract<Segment, { type: 'image' }>;
type VisionCall = (messages: OpenAI.ChatCompletionMessageParam[]) => Promise<SlotResult>;
type ImageFetcher = (url: string, init: RequestInit) => Promise<Response>;
export type ImageDownloader = (url: string) => Promise<string>;

class ImageHostNotAllowedError extends Error {
  readonly code = 'IMAGE_HOST_NOT_ALLOWED';
  readonly hostname: string;

  constructor(hostname: string) {
    super(`图片下载主机不在允许范围：${hostname}`);
    this.name = 'ImageHostNotAllowedError';
    this.hostname = hostname;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTextSegment(value: unknown): value is { type: 'text'; text: string } {
  return isRecord(value) && value.type === 'text' && typeof value.text === 'string';
}

function isImageSegment(value: unknown): value is ImageSegment {
  return isRecord(value)
    && value.type === 'image'
    && typeof value.url === 'string'
    && (value.file === undefined || typeof value.file === 'string')
    && (value.subType === undefined || typeof value.subType === 'number')
    && (value.md5 === undefined || typeof value.md5 === 'string');
}

function isStickerSegment(value: unknown): value is Extract<Segment, { type: 'sticker' }> {
  return isRecord(value)
    && value.type === 'sticker'
    && typeof value.emojiId === 'string'
    && (value.summary === undefined || typeof value.summary === 'string');
}

function validMd5(value: string | undefined): value is string {
  return typeof value === 'string' && /^[a-f\d]{32}$/iu.test(value);
}

function withForcedSticker(description: VisionDescription, forceSticker: boolean): VisionDescription {
  return forceSticker ? { ...description, kind: 'sticker' } : description;
}

function cachedCaption(
  repository: StoreRepository,
  md5: string,
  visionModel: string,
  visionTemplateVersion: string,
): ImageCaptionRecord | undefined {
  const cached = repository.getImageCaption(md5);
  if (!cached || cached.visionModel !== visionModel
    || cached.visionTemplateVersion !== visionTemplateVersion) return undefined;
  return cached;
}

function isSupportedImageUrl(value: string): boolean {
  if (/^data:image\/(?:jpeg|png|gif|webp);base64,/iu.test(value)) return true;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '';
  } catch {
    return false;
  }
}

function isAllowedTencentImageHost(hostname: string): boolean {
  return ALLOWED_IMAGE_HOST_SUFFIXES.some((suffix) => (
    hostname === suffix || hostname.endsWith(`.${suffix}`)
  ));
}

async function readBoundedImageBody(response: Response): Promise<Uint8Array> {
  const body = response.body;
  if (!body) throw new Error('图片响应没有内容');
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_IMAGE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error('图片响应超过 5 MiB 限制');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (result.byteLength === 0) throw new Error('图片响应没有内容');
  return result;
}

export async function downloadImageAsDataUrl(
  imageUrl: string,
  fetcher: ImageFetcher = fetch,
  timeoutMs = IMAGE_DOWNLOAD_TIMEOUT_MS,
): Promise<string> {
  if (/^data:image\/(?:jpeg|png|gif|webp);base64,/iu.test(imageUrl)) return imageUrl;

  let url: URL;
  try {
    url = new URL(imageUrl);
  } catch {
    throw new Error('图片链接不是有效的 http(s) 地址');
  }
  if (!url.hostname || url.username || url.password) {
    throw new Error('图片链接不是有效的 http(s) 地址');
  }
  if (url.protocol !== 'https:' || !isAllowedTencentImageHost(url.hostname)) {
    throw new ImageHostNotAllowedError(url.hostname);
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('图片下载超时设置无效');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(imageUrl, { signal: controller.signal });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`图片下载失败（HTTP ${response.status}）`);
    }

    const mediaType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (!mediaType || !SUPPORTED_IMAGE_TYPES.has(mediaType)) {
      await response.body?.cancel().catch(() => {});
      throw new Error('图片响应 content-type 不受支持');
    }

    const contentLengthHeader = response.headers.get('content-length');
    if (contentLengthHeader !== null) {
      const contentLength = Number(contentLengthHeader);
      if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
        await response.body?.cancel().catch(() => {});
        throw new Error('图片响应超过 5 MiB 限制');
      }
    }

    const bytes = await readBoundedImageBody(response);
    return `data:${mediaType};base64,${Buffer.from(bytes).toString('base64')}`;
  } finally {
    clearTimeout(timeout);
  }
}

function visionMessages(urls: string[], template: VisionPromptTemplate): OpenAI.ChatCompletionMessageParam[] {
  return [
    {
      role: 'system',
      content: template.system,
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: template.user },
        ...urls.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
      ],
    },
  ];
}

function pngDataUrl(frame: ReturnType<typeof decodeGifFrames>[number]): string {
  const bytes = Buffer.from(encodePng(frame));
  if (bytes.length > MAX_IMAGE_BYTES) throw new RangeError('GIF 关键帧 PNG 超过 5 MiB');
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

function isGifData(mediaType: string, bytes: Uint8Array): boolean {
  const header = String.fromCharCode(...bytes.subarray(0, 6));
  return mediaType === 'image/gif' || header === 'GIF87a' || header === 'GIF89a';
}

function renderStickerRecord(repository: StoreRepository, account: number, md5: string): string | undefined {
  const description = repository.stickerByMd5(account, md5);
  const text = description?.manualDesc || description?.descAi || description?.descQq;
  return text ? `[表情包：${text}]` : undefined;
}

function renderCachedCaption(cached: ImageCaptionRecord, forceSticker: boolean): string {
  if (!forceSticker || cached.kind === 'sticker') return cached.caption;
  return renderVisionDescription({ ...cached, kind: 'sticker' });
}

function usableImageCaption(
  repository: StoreRepository,
  account: number,
  md5: string,
  visionModel: string,
  visionTemplateVersion: string,
  forceSticker = false,
): string | undefined {
  const sticker = renderStickerRecord(repository, account, md5);
  if (sticker) return sticker;
  const cached = cachedCaption(repository, md5, visionModel, visionTemplateVersion);
  return cached ? renderCachedCaption(cached, forceSticker) : undefined;
}

export async function captionIncomingImages(options: {
  message: IncomingMessage;
  repository: StoreRepository;
  callVision: VisionCall;
  visionTemplate: VisionPromptTemplate;
  visionModel?: string;
  downloadImage?: ImageDownloader;
  persistMd5?: boolean;
  onError?: (error: unknown, message: IncomingMessage) => void;
  now?: () => number;
}): Promise<void> {
  const now = options.now ?? Date.now;
  const visionModel = options.visionModel ?? 'unknown';
  const attempted = new Set<string>();
  let segmentsChanged = false;

  for (const segment of options.message.segments) {
    if (segment.type !== 'image') continue;
    let md5 = imageMd5FromFile(segment.file)
      ?? (validMd5(segment.md5) ? segment.md5.toLowerCase() : undefined);
    if (md5 && segment.md5 !== md5) {
      segment.md5 = md5;
      segmentsChanged = true;
    }
    if (md5 && usableImageCaption(
      options.repository,
      options.message.session.account,
      md5,
      visionModel,
      options.visionTemplate.version,
      segment.subType === 1,
    )) continue;

    try {
      if (!isSupportedImageUrl(segment.url)) {
        throw new Error('图片段缺少可供 vision 槽位读取的 http(s) 或图片 data URL');
      }
      const imageData = await (options.downloadImage ?? downloadImageAsDataUrl)(segment.url);
      const decoded = imageBytesFromDataUrl(imageData, MAX_IMAGE_BYTES);
      md5 ??= computeImageMd5(decoded.bytes);
      if (segment.md5 !== md5) {
        segment.md5 = md5;
        segmentsChanged = true;
      }
      if (attempted.has(md5)) continue;
      attempted.add(md5);
      if (usableImageCaption(
        options.repository,
        options.message.session.account,
        md5,
        visionModel,
        options.visionTemplate.version,
        segment.subType === 1,
      )) continue;

      let selectedFrames: ReturnType<typeof decodeGifFrames> | undefined;
      let frameDataUrls: string[] = [];
      let firstImageUrl = imageData;
      if (isGifData(decoded.mediaType, decoded.bytes)) {
        try {
          selectedFrames = selectGifFrames(decodeGifFrames(decoded.bytes));
          if (selectedFrames.length > 0) {
            firstImageUrl = pngDataUrl(createGifMontage(selectedFrames));
            frameDataUrls = selectedFrames.map(pngDataUrl);
          }
        } catch (error) {
          options.onError?.(error, options.message);
          selectedFrames = undefined;
          frameDataUrls = [];
          firstImageUrl = imageData;
        }
      }

      const forceSticker = segment.subType === 1;
      let description = withForcedSticker(
        parseVisionDescription((await options.callVision(visionMessages([firstImageUrl], options.visionTemplate))).text),
        forceSticker,
      );
      if (selectedFrames && frameDataUrls.length > 0
        && (!description.legible || (description.kind === 'sticker' && !description.text.trim()))) {
        description = withForcedSticker(
          parseVisionDescription((await options.callVision(visionMessages(frameDataUrls, options.visionTemplate))).text),
          forceSticker,
        );
        if (!description.legible || (description.kind === 'sticker' && !description.text.trim())) {
          description = withUnreadableText(description);
        }
      } else if (!description.legible) {
        description = { ...description, text: '' };
      }
      if (!description.desc) throw new Error('vision 槽位返回了空描述');

      const record = {
        md5,
        caption: renderVisionDescription(description),
        kind: description.kind,
        desc: description.desc,
        text: description.text,
        legible: description.legible,
        visionModel,
        visionTemplateVersion: options.visionTemplate.version,
        time: now(),
      };
      options.repository.setImageCaption(record);
    } catch (error) {
      options.onError?.(error, options.message);
    }
  }

  if (segmentsChanged && options.persistMd5 !== false) {
    options.repository.updateMessageSegments(
      sessionId(options.message.session),
      options.message.messageId,
      options.message.segments,
    );
  }
}

function imagePlaceholder(
  image: ImageSegment,
  repository: StoreRepository,
  visionTemplateVersion: string,
  visionModel: string,
  account: number | undefined,
): string {
  const md5 = validMd5(image.md5) ? image.md5.toLowerCase() : imageMd5FromFile(image.file);
  if (md5) {
    const sticker = account === undefined ? undefined : renderStickerRecord(repository, account, md5);
    const cached = cachedCaption(repository, md5, visionModel, visionTemplateVersion);
    const caption = cached ? renderCachedCaption(cached, image.subType === 1) : undefined;
    if (sticker || caption) return sticker ?? caption!;
  }
  return image.subType === 1 ? '[表情包]' : '[图片]';
}

export function messageTextWithImageCaptions(
  message: MessageStorageRecord,
  repository: StoreRepository,
  visionTemplateVersion: string,
  visionModel = 'unknown',
): string {
  const hasMeaningSegments = message.segments.some((segment) => isImageSegment(segment) || isStickerSegment(segment));
  if (!hasMeaningSegments) return message.plainText;
  const accountToken = message.sessionId.split(':', 1)[0];
  const account = accountToken && /^\d+$/u.test(accountToken) ? Number(accountToken) : undefined;
  return message.segments.map((segment) => {
    if (isTextSegment(segment)) return segment.text;
    if (isImageSegment(segment)) {
      return imagePlaceholder(segment, repository, visionTemplateVersion, visionModel, account);
    }
    if (isStickerSegment(segment)) return segment.summary ?? '[表情包]';
    return '';
  }).join('');
}
