import { createHash } from 'node:crypto';

export interface DecodedImageData {
  bytes: Buffer;
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
}

export function imageMd5FromFile(file: string | undefined): string | undefined {
  if (!file) return undefined;
  const basename = file.slice(Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\')) + 1);
  const match = /^([a-f\d]{32})(?:\.[^./\\]+)?$/iu.exec(basename);
  return match?.[1]?.toLowerCase();
}

export function computeImageMd5(bytes: Uint8Array): string {
  if (bytes.length === 0) throw new TypeError('图片内容不能为空');
  return createHash('md5').update(bytes).digest('hex');
}

export function imageBytesFromDataUrl(value: string, maxBytes: number): DecodedImageData {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('图片大小上限无效');
  const match = /^data:(image\/(?:jpeg|png|gif|webp));base64,([A-Za-z\d+/]+={0,2})$/iu.exec(value);
  if (!match?.[1] || !match[2]) throw new TypeError('图片下载结果不是受支持的 data URL');
  if (match[2].length > Math.ceil(maxBytes / 3) * 4) throw new RangeError('图片超过大小限制');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length > maxBytes) throw new RangeError('图片超过大小限制');
  if (bytes.length === 0 || bytes.toString('base64') !== match[2]) throw new TypeError('图片 Base64 数据无效');
  return { bytes, mediaType: match[1].toLowerCase() as DecodedImageData['mediaType'] };
}
