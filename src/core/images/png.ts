import { deflateSync } from 'node:zlib';
import type { GifFrame } from './gif.ts';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  return crc >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const payload = Buffer.concat([typeBytes, Buffer.from(data)]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(payload));
  return Buffer.concat([length, payload, checksum]);
}

export function createGifMontage(frames: GifFrame[]): GifFrame {
  if (frames.length === 0 || frames.length > 4) throw new RangeError('GIF 拼接帧数必须为 1–4');
  const first = frames[0]!;
  const width = first.width * 2;
  const height = first.height * 2;
  const rgba = new Uint8Array(width * height * 4);

  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index]!;
    if (frame.width !== first.width || frame.height !== first.height
      || frame.rgba.length !== frame.width * frame.height * 4) {
      throw new TypeError('GIF 拼接帧尺寸不一致');
    }
    const left = (index % 2) * first.width;
    const top = Math.floor(index / 2) * first.height;
    for (let y = 0; y < first.height; y += 1) {
      const sourceOffset = y * first.width * 4;
      const destinationOffset = ((top + y) * width + left) * 4;
      rgba.set(frame.rgba.subarray(sourceOffset, sourceOffset + first.width * 4), destinationOffset);
    }
  }
  return { width, height, rgba };
}

export function encodePng(frame: GifFrame): Uint8Array {
  if (!Number.isSafeInteger(frame.width) || !Number.isSafeInteger(frame.height)
    || frame.width < 1 || frame.height < 1 || frame.rgba.length !== frame.width * frame.height * 4) {
    throw new TypeError('PNG 图片尺寸或像素数据无效');
  }
  const rowBytes = frame.width * 4;
  const raw = Buffer.alloc((rowBytes + 1) * frame.height);
  for (let y = 0; y < frame.height; y += 1) {
    const destinationOffset = y * (rowBytes + 1);
    raw[destinationOffset] = 0;
    raw.set(frame.rgba.subarray(y * rowBytes, (y + 1) * rowBytes), destinationOffset + 1);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(frame.width, 0);
  header.writeUInt32BE(frame.height, 4);
  header[8] = 8;
  header[9] = 6;
  const compressed = deflateSync(raw);
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}
