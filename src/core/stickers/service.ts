import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { canCallWithDailyBudget, isBudgetExceededError } from '../../llm/budget.ts';
import { downloadImageAsDataUrl } from '../images/index.ts';
import { computeImageMd5 } from '../images/fingerprint.ts';
import { sessionId, type IncomingMessage, type Segment, type SessionKey } from '../shared/events.ts';
import type { AquariumConfig } from '../../config/schema.ts';
import type { MoodBand } from '../../store/affect-repo.ts';
import type { StoreRepository } from '../../store/repository.ts';
import type { CustomFaceActions, CustomFaceDetail } from '../../adapters/types.ts';
import { selectStickerCandidates, type StickerOffer } from './selection.ts';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const STICKER_SYNC_COUNT = 300;
const MAX_DESCRIPTION_ATTEMPTS = 3;

class DuplicateStickerError extends Error {}

function duplicateErrorFields(value: unknown, depth = 0): string[] {
  if (typeof value === 'string') return [value];
  if (value instanceof Error) return [value.name, value.message];
  if (typeof value !== 'object' || value === null || Array.isArray(value) || depth >= 2) return [];
  const record = value as Record<string, unknown>;
  const fields: string[] = [];
  for (const key of ['code', 'message', 'wording', 'error', 'detail', 'data', 'response']) {
    const field = record[key];
    if (typeof field === 'string') fields.push(field);
    else fields.push(...duplicateErrorFields(field, depth + 1));
  }
  return fields;
}

function isDuplicateFaceError(error: unknown): boolean {
  return duplicateErrorFields(error).some((value) => (
    /duplicate|already\s+(?:added|exists?|collected)|重复|已存在|已经收藏|收藏过/iu.test(value)
  ));
}

export type StickerRemoteDetail = CustomFaceDetail;
export type StickerAdapter = CustomFaceActions;

export interface StickerSyncResult {
  account: number;
  received: number;
  inserted: number;
  downloaded: number;
  described: number;
  markedMissing: number;
  skippedByBudget: boolean;
}

export interface StickerService {
  readonly account: number;
  sync(): Promise<StickerSyncResult>;
  collect(message: IncomingMessage): Promise<{ ok: boolean; reason?: string }>;
  upload(dataBase64: string, filename: string): Promise<{ synced: boolean }>;
  modifyCustomFace(emojiId: string, desc: string): Promise<void>;
  getLastSyncAt(): number | null;
  offer(input: {
    sessionId: string;
    messageText: string;
    moodBand: MoodBand;
    now: number;
  }): StickerOffer | null;
  stickerBase64(file: string): string | null;
  sendSticker(input: {
    session: SessionKey;
    sticker: StickerOffer['candidates'][number];
  }): Promise<{ messageId: string }>;
  recordUse(stickerId: number, now: number): void;
}

export interface StickerServiceOptions {
  account: number;
  adapter: StickerAdapter;
  repository: StoreRepository;
  dataDirectory: string;
  getConfig: () => AquariumConfig;
  downloadImage?: (url: string) => Promise<string>;
  describeImage: (dataUrl: string) => Promise<string>;
  onError?: (stage: 'sync' | 'download' | 'describe' | 'collect' | 'upload') => void;
  now?: () => number;
}

interface DecodedImage {
  bytes: Buffer;
  extension: 'jpg' | 'png' | 'gif' | 'webp';
  mimeType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
}

function decodeBase64(value: string): Buffer {
  if (value.length % 4 === 1 || !/^[A-Za-z\d+/]+={0,2}$/u.test(value)) {
    throw new TypeError('图片 Base64 格式无效');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES
    || bytes.toString('base64').replace(/=+$/u, '') !== value.replace(/=+$/u, '')) {
    throw new RangeError('图片必须为非空且不超过 5 MiB');
  }
  return bytes;
}

function imageFormat(bytes: Buffer): Pick<DecodedImage, 'extension' | 'mimeType'> {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { extension: 'jpg', mimeType: 'image/jpeg' };
  }
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { extension: 'png', mimeType: 'image/png' };
  }
  const gifHeader = bytes.subarray(0, 6).toString('ascii');
  if (gifHeader === 'GIF87a' || gifHeader === 'GIF89a') {
    return { extension: 'gif', mimeType: 'image/gif' };
  }
  if (bytes.length >= 12
    && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { extension: 'webp', mimeType: 'image/webp' };
  }
  throw new TypeError('图片文件头格式不受支持');
}

function decodeImageDataUrl(value: string): DecodedImage {
  const match = /^data:image\/(?:jpeg|png|gif|webp);base64,([A-Za-z\d+/]+={0,2})$/iu.exec(value);
  if (!match?.[1]) throw new TypeError('图片下载结果不是受支持的 data URL');
  const bytes = decodeBase64(match[1]);
  return { bytes, ...imageFormat(bytes) };
}

function normalizedDescription(text: string): { desc: string; tags: string[] } | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'desc' && key !== 'tags')) return undefined;
  if (typeof record.desc !== 'string' || !Array.isArray(record.tags)) return undefined;
  const desc = record.desc.trim();
  const tags = record.tags;
  if (Array.from(desc).length === 0 || Array.from(desc).length > 20 || tags.length > 5
    || tags.some((tag) => typeof tag !== 'string'
      || Array.from(tag.trim()).length < 2
      || Array.from(tag.trim()).length > 4)) {
    return undefined;
  }
  return { desc, tags: tags.map((tag) => (tag as string).trim()) };
}

function validateRemoteDetail(detail: StickerRemoteDetail): void {
  if (!detail.emojiId.trim() || !detail.resId.trim() || typeof detail.desc !== 'string'
    || !/^https:\/\//iu.test(detail.url) || !/^[a-f\d]{32}$/iu.test(detail.md5)) {
    throw new Error('QQ 收藏表情详情格式无效');
  }
}

function safeImageFile(dataDirectory: string, file: string): string | undefined {
  if (!/^[a-f\d]{32}\.(?:jpg|png|gif|webp)$/iu.test(file) || path.basename(file) !== file) return undefined;
  const directory = path.resolve(dataDirectory);
  const target = path.resolve(directory, file);
  return target.startsWith(`${directory}${path.sep}`) ? target : undefined;
}

function persistImage(dataDirectory: string, md5: string, image: DecodedImage): string {
  mkdirSync(dataDirectory, { recursive: true });
  const filename = `${md5.toLowerCase()}.${image.extension}`;
  const destination = safeImageFile(dataDirectory, filename);
  if (!destination) throw new Error('表情文件路径无效');
  const temporary = path.join(dataDirectory, `.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, image.bytes, { flag: 'wx' });
    if (existsSync(destination)) rmSync(destination, { force: true });
    renameSync(temporary, destination);
  } finally {
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
  return filename;
}

function readStickerDataUrl(dataDirectory: string, file: string): string | undefined {
  const filePath = safeImageFile(dataDirectory, file);
  if (!filePath || !existsSync(filePath)) return undefined;
  const bytes = readFileSync(filePath);
  if (bytes.length > MAX_IMAGE_BYTES) return undefined;
  try {
    const image = { bytes, ...imageFormat(bytes) };
    return `data:${image.mimeType};base64,${bytes.toString('base64')}`;
  } catch {
    return undefined;
  }
}

function firstReply(segments: Segment[]): Extract<Segment, { type: 'reply' }> | undefined {
  return segments.find((segment): segment is Extract<Segment, { type: 'reply' }> => segment.type === 'reply');
}

function firstStoredImage(segments: unknown[]): { url?: string; file?: string } | undefined {
  for (const value of segments) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
    const segment = value as Record<string, unknown>;
    if (segment.type !== 'image') continue;
    return {
      ...(typeof segment.url === 'string' ? { url: segment.url } : {}),
      ...(typeof segment.file === 'string' ? { file: segment.file } : {}),
    };
  }
  return undefined;
}

function validatedFilename(filename: string, image: DecodedImage): void {
  if (!filename.trim() || filename.length > 255 || path.basename(filename) !== filename
    || filename.includes('/') || filename.includes('\\')) {
    throw new TypeError('上传文件名无效');
  }
  const extension = path.extname(filename).slice(1).toLowerCase();
  if (extension !== image.extension && !(extension === 'jpeg' && image.extension === 'jpg')) {
    throw new TypeError('文件扩展名与图片内容不匹配');
  }
}

export function createStickerService(options: StickerServiceOptions): StickerService {
  const now = options.now ?? Date.now;
  const downloadImage = options.downloadImage ?? downloadImageAsDataUrl;
  let lastSyncAt: number | null = null;
  let syncRequest: Promise<StickerSyncResult> | undefined;

  async function describePending(): Promise<{ described: number; skippedByBudget: boolean }> {
    let described = 0;
    let skippedByBudget = false;
    for (const sticker of options.repository.stickersNeedingDescription(options.account, MAX_DESCRIPTION_ATTEMPTS)) {
      if (!canCallWithDailyBudget(options.getConfig(), 'vision', options.repository.costToday())) {
        skippedByBudget = true;
        break;
      }
      const dataUrl = sticker.file ? readStickerDataUrl(options.dataDirectory, sticker.file) : undefined;
      if (!dataUrl) {
        options.repository.setStickerFile(sticker.id, null, now());
        continue;
      }
      try {
        const parsed = normalizedDescription(await options.describeImage(dataUrl));
        if (!parsed) {
          options.repository.recordStickerDescriptionAttempt(sticker.id, now());
          options.onError?.('describe');
          continue;
        }
        options.repository.saveStickerDescription(sticker.id, parsed.desc, parsed.tags, now());
        described += 1;
      } catch (error) {
        if (isBudgetExceededError(error)) {
          skippedByBudget = true;
          break;
        }
        options.repository.recordStickerDescriptionAttempt(sticker.id, now());
        options.onError?.('describe');
      }
    }
    return { described, skippedByBudget };
  }

  async function runSync(): Promise<StickerSyncResult> {
    const details = await options.adapter.fetchDetails(STICKER_SYNC_COUNT);
    let inserted = 0;
    let downloaded = 0;
    const seen = new Set<string>();
    for (const detail of details) {
      validateRemoteDetail(detail);
      const md5 = detail.md5.toLowerCase();
      seen.add(md5);
      const { sticker, inserted: isInserted } = options.repository.upsertSticker({
        account: options.account,
        emojiId: detail.emojiId,
        md5,
        descQq: detail.desc,
      }, now());
      if (isInserted) inserted += 1;
      if (sticker.file && safeImageFile(options.dataDirectory, sticker.file)
        && existsSync(safeImageFile(options.dataDirectory, sticker.file)!)) continue;

      try {
        const image = decodeImageDataUrl(await downloadImage(detail.url));
        const file = persistImage(options.dataDirectory, md5, image);
        options.repository.setStickerFile(sticker.id, file, now());
        downloaded += 1;
      } catch {
        options.repository.setStickerFile(sticker.id, null, now());
        options.onError?.('download');
      }
    }
    const markedMissing = options.repository.markMissingStickers(options.account, [...seen], now());
    const description = await describePending();
    lastSyncAt = now();
    return {
      account: options.account,
      received: details.length,
      inserted,
      downloaded,
      described: description.described,
      markedMissing,
      skippedByBudget: description.skippedByBudget,
    };
  }

  function sync(): Promise<StickerSyncResult> {
    if (syncRequest) return syncRequest;
    syncRequest = runSync().catch((error: unknown) => {
      options.onError?.('sync');
      throw error;
    }).finally(() => {
      syncRequest = undefined;
    });
    return syncRequest;
  }

  async function addAndSync(file: string, stage: 'collect' | 'upload'): Promise<void> {
    try {
      await options.adapter.addCustomFace(file);
    } catch (error) {
      options.onError?.(stage);
      if (stage === 'collect' && isDuplicateFaceError(error)) throw new DuplicateStickerError();
      throw new Error('QQ 收藏接口失败');
    }
    try {
      await sync();
    } catch {
      options.onError?.(stage);
    }
  }

  async function collect(message: IncomingMessage): Promise<{ ok: boolean; reason?: string }> {
    const reply = firstReply(message.segments);
    if (!reply) return { ok: false, reason: '没有引用图片' };
    if (message.session.account !== options.account) return { ok: false, reason: '账号不匹配' };
    const stored = options.repository.messageBySessionAndId(sessionId(message.session), reply.messageId);
    const image = stored ? firstStoredImage(stored.segments) : undefined;
    if (!image) return { ok: false, reason: '引用消息中没有图片' };

    let downloaded: DecodedImage | undefined;
    if (image.url) {
      try {
        downloaded = decodeImageDataUrl(await downloadImage(image.url));
      } catch {
        downloaded = undefined;
      }
    }
    if (!downloaded && image.file) {
      try {
        const refreshedUrl = await options.adapter.getImageUrl(image.file);
        downloaded = decodeImageDataUrl(await downloadImage(refreshedUrl));
      } catch {
        return { ok: false, reason: '引用图片已过期或无法读取' };
      }
    }
    if (!downloaded) return { ok: false, reason: '引用图片已过期或无法读取' };
    const md5 = computeImageMd5(downloaded.bytes);
    if (options.repository.stickerByMd5(options.account, md5)) {
      return { ok: false, reason: 'already_collected' };
    }
    try {
      await addAndSync(`base64://${downloaded.bytes.toString('base64')}`, 'collect');
      return { ok: true };
    } catch (error) {
      if (error instanceof DuplicateStickerError) return { ok: false, reason: 'already_collected' };
      return { ok: false, reason: 'QQ 收藏接口失败' };
    }
  }

  async function upload(dataBase64: string, filename: string): Promise<{ synced: boolean }> {
    const bytes = decodeBase64(dataBase64);
    const image = { bytes, ...imageFormat(bytes) };
    validatedFilename(filename, image);
    try {
      await options.adapter.addCustomFace(`base64://${image.bytes.toString('base64')}`);
    } catch {
      options.onError?.('upload');
      throw new Error('QQ 收藏接口失败');
    }
    try {
      await sync();
      return { synced: true };
    } catch {
      options.onError?.('upload');
      return { synced: false };
    }
  }

  return {
    account: options.account,
    sync,
    collect,
    upload,
    modifyCustomFace: (emojiId, desc) => options.adapter.modifyCustomFace(emojiId, desc),
    getLastSyncAt: () => lastSyncAt,
    offer(input) {
      return selectStickerCandidates({
        config: options.getConfig().stickers,
        stickers: options.repository.listStickers(options.account),
        history: options.repository.decisionsInRange(input.sessionId, input.now - 2 * 60 * 60 * 1000, input.now),
        messageText: input.messageText,
        moodBand: input.moodBand,
        sessionId: input.sessionId,
        now: input.now,
      });
    },
    stickerBase64(file) {
      const dataUrl = readStickerDataUrl(options.dataDirectory, file);
      return dataUrl?.slice(dataUrl.indexOf(',') + 1) ?? null;
    },
    sendSticker: (input) => options.adapter.sendCustomFace({
      session: input.session,
      emojiId: input.sticker.emojiId,
    }),
    recordUse: (stickerId, at) => {
      options.repository.recordStickerUse(stickerId, at);
    },
  };
}
