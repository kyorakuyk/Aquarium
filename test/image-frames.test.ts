import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeGifFrames, selectGifFrames, type GifFrame } from '../src/core/images/gif.ts';
import { createGifMontage, encodePng } from '../src/core/images/png.ts';
import { computeImageMd5, imageBytesFromDataUrl, imageMd5FromFile } from '../src/core/images/fingerprint.ts';
import { onePixelGif } from './gif-fixtures.ts';

function frame(value: number): GifFrame {
  const rgba = new Uint8Array(32 * 32 * 4);
  for (let offset = 0; offset < rgba.length; offset += 4) {
    rgba[offset] = value;
    rgba[offset + 1] = value;
    rgba[offset + 2] = value;
    rgba[offset + 3] = 255;
  }
  return { width: 32, height: 32, rgba };
}

test('图片 MD5 优先从文件名提取，缺少文件名时可按图片内容计算', () => {
  assert.equal(imageMd5FromFile('subdir/900150983cd24fb0d6963f7d28e17f72.gif'), '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(imageMd5FromFile('not-an-md5.png'), undefined);
  assert.equal(computeImageMd5(Buffer.from('abc')), '900150983cd24fb0d6963f7d28e17f72');
});

test('图片 data URL 解码遵守调用方提供的字节上限', () => {
  assert.throws(
    () => imageBytesFromDataUrl('data:image/png;base64,AQID', 2),
    /超过大小限制/u,
  );
});

test('GIF 解码将各帧 LZW 像素合成为屏幕帧', () => {
  const decoded = decodeGifFrames(onePixelGif([0, 1, 2, 3]));
  assert.deepEqual(decoded.map((image) => image.rgba[0]), [0, 40, 80, 120]);
});

test('GIF 选帧：静态只留首帧，匀速变化取四个分位，突变按累计变化去重', () => {
  const cases: Array<{ name: string; values: number[]; expected: number[] }> = [
    { name: 'static', values: [12, 12, 12], expected: [12] },
    { name: 'uniform', values: [0, 40, 80, 120], expected: [0, 40, 80, 120] },
    { name: 'sudden', values: [0, 0, 0, 255], expected: [0, 255] },
  ];

  for (const sample of cases) {
    const selected = selectGifFrames(sample.values.map(frame));
    assert.deepEqual(selected.map((image) => image.rgba[0]), sample.expected, sample.name);
  }
});

test('GIF 关键帧拼接保留原分辨率并编码为 PNG', () => {
  const montage = createGifMontage([frame(10), frame(80), frame(160)]);
  const staticMontage = createGifMontage([frame(20)]);
  const png = Buffer.from(encodePng(montage));

  assert.equal(montage.width, 64);
  assert.equal(montage.height, 64);
  assert.equal(montage.rgba[0], 10);
  assert.equal(montage.rgba[(32 * 4)], 80);
  assert.equal(montage.rgba[(32 * 64) * 4], 160);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 64);
  assert.equal(png.readUInt32BE(20), 64);
  assert.equal(staticMontage.width, 64);
  assert.equal(staticMontage.height, 64);
  assert.equal(staticMontage.rgba[(32 * 64 + 32) * 4 + 3], 0);
});
