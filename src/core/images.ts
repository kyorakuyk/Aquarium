import { createHash } from 'node:crypto';
import type OpenAI from 'openai';
import type { IncomingMessage, Segment } from './events.ts';
import type { MessageStorageRecord, StoreRepository } from '../store/repository.ts';
import type { SlotResult } from '../llm/slots.ts';
import type { VisionPromptTemplate } from './prompt-templates.ts';

const MAX_CAPTION_LENGTH = 30;
const MAX_IMAGE_TEXT_LENGTH = 200;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 10_000;
const SUPPORTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const ALLOWED_IMAGE_HOST_SUFFIXES = ['qq.com.cn', 'qq.com', 'qpic.cn'];

type ImageSegment = Extract<Segment, { type: 'image' }>;
type VisionCall = (messages: OpenAI.ChatCompletionMessageParam[]) => Promise<SlotResult>;
type ImageFetcher = (url: string, init: RequestInit) => Promise<Response>;
export type ImageDownloader = (url: string) => Promise<string>;
type VisionKind = 'sticker' | 'photo' | 'screenshot' | 'other';

interface VisionDescription {
  kind: VisionKind;
  desc: string;
  text: string;
}

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
    && (value.subType === undefined || typeof value.subType === 'number');
}

export function imageCaptionCacheKey(image: ImageSegment, visionTemplateVersion: string): string {
  const source = image.file || createHash('sha1').update(image.url).digest('hex');
  return `vision:${visionTemplateVersion}:subtype-${image.subType ?? 0}:${source}`;
}

function normalizeCaption(value: string): string {
  return Array.from(value.replace(/\s+/gu, ' ').trim())
    .slice(0, MAX_CAPTION_LENGTH)
    .join('');
}

function parseVisionDescription(value: string): VisionDescription {
  const fallback = (): VisionDescription => ({ kind: 'other', desc: normalizeCaption(value), text: '' });
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)
      || !['sticker', 'photo', 'screenshot', 'other'].includes(String(parsed.kind))
      || typeof parsed.desc !== 'string'
      || typeof parsed.text !== 'string') return fallback();
    const desc = normalizeCaption(parsed.desc);
    if (!desc) return fallback();
    return {
      kind: parsed.kind as VisionKind,
      desc,
      text: Array.from(parsed.text).slice(0, MAX_IMAGE_TEXT_LENGTH).join(''),
    };
  } catch {
    return fallback();
  }
}

function renderVisionDescription(description: VisionDescription, forceSticker: boolean): string {
  const kind = forceSticker ? 'sticker' : description.kind;
  const label = kind === 'sticker' ? '表情包' : kind === 'screenshot' ? '截图' : '图片';
  const prefix = `[${label}：${description.desc}`;
  if (!description.text.trim()) return `${prefix}]`;
  const textLabel = kind === 'screenshot' ? '｜文字：' : '｜图上写着';
  return `${prefix}${textLabel}“${description.text}”]`;
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

  const response = await fetcher(imageUrl, { signal: AbortSignal.timeout(timeoutMs) });
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
}

function visionMessages(url: string, template: VisionPromptTemplate): OpenAI.ChatCompletionMessageParam[] {
  return [
    {
      role: 'system',
      content: template.system,
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: template.user },
        { type: 'image_url', image_url: { url } },
      ],
    },
  ];
}

export async function captionIncomingImages(options: {
  message: IncomingMessage;
  repository: StoreRepository;
  callVision: VisionCall;
  visionTemplate: VisionPromptTemplate;
  downloadImage?: ImageDownloader;
  onError?: (error: unknown, message: IncomingMessage) => void;
  now?: () => number;
}): Promise<void> {
  const now = options.now ?? Date.now;
  const attempted = new Set<string>();

  for (const segment of options.message.segments) {
    if (segment.type !== 'image') continue;
    const key = imageCaptionCacheKey(segment, options.visionTemplate.version);
    if (options.repository.getCaption(key) !== undefined || attempted.has(key)) continue;
    attempted.add(key);

    try {
      if (!isSupportedImageUrl(segment.url)) {
        throw new Error('图片段缺少可供 vision 槽位读取的 http(s) 或图片 data URL');
      }
      const imageData = await (options.downloadImage ?? downloadImageAsDataUrl)(segment.url);
      const result = await options.callVision(visionMessages(imageData, options.visionTemplate));
      const description = parseVisionDescription(result.text);
      if (!description.desc) throw new Error('vision 槽位返回了空描述');
      const caption = renderVisionDescription(description, segment.subType === 1);
      options.repository.setCaption(key, caption, now());
    } catch (error) {
      options.onError?.(error, options.message);
    }
  }
}

function imagePlaceholder(
  image: ImageSegment,
  repository: StoreRepository,
  visionTemplateVersion: string,
): string {
  return repository.getCaption(imageCaptionCacheKey(image, visionTemplateVersion))
    ?? (image.subType === 1 ? '[表情包]' : '[图片]');
}

export function messageTextWithImageCaptions(
  message: MessageStorageRecord,
  repository: StoreRepository,
  visionTemplateVersion: string,
): string {
  if (!message.segments.some(isImageSegment)) return message.plainText;
  return message.segments.map((segment) => {
    if (isTextSegment(segment)) return segment.text;
    if (isImageSegment(segment)) return imagePlaceholder(segment, repository, visionTemplateVersion);
    return '';
  }).join('');
}
