export interface GifFrame {
  width: number;
  height: number;
  rgba: Uint8Array;
}

const MAX_GIF_FRAME_COUNT = 200;
const MAX_GIF_CANVAS_PIXELS = 8_000_000;
const MAX_GIF_TOTAL_PIXELS = 16_000_000;
const THUMBNAIL_SIZE = 32;
const MINIMUM_CHANGE = 2 / 255;

function readWord(bytes: Uint8Array, offset: number): number {
  if (offset + 1 >= bytes.length) throw new Error('GIF 数据被截断');
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readSubBlocks(bytes: Uint8Array, cursor: { offset: number }): Uint8Array {
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const size = bytes[cursor.offset++];
    if (size === undefined) throw new Error('GIF 子块数据被截断');
    if (size === 0) break;
    const end = cursor.offset + size;
    if (end > bytes.length) throw new Error('GIF 子块数据被截断');
    chunks.push(bytes.subarray(cursor.offset, end));
    length += size;
    cursor.offset = end;
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function decodeLzw(data: Uint8Array, minimumCodeSize: number, expected: number): Uint8Array {
  if (minimumCodeSize < 2 || minimumCodeSize > 8) throw new Error('GIF LZW 码长无效');
  const clearCode = 1 << minimumCodeSize;
  const endCode = clearCode + 1;
  const prefix = new Int16Array(4096);
  const suffix = new Uint8Array(4096);
  const stack = new Uint8Array(4097);
  for (let code = 0; code < clearCode; code += 1) suffix[code] = code;

  let bitOffset = 0;
  let codeSize = minimumCodeSize + 1;
  let nextCode = endCode + 1;
  let previousCode = -1;
  let firstCharacter = 0;
  const output = new Uint8Array(expected);
  let outputOffset = 0;
  let ended = false;

  function readCode(): number | undefined {
    if (bitOffset + codeSize > data.length * 8) return undefined;
    let value = 0;
    for (let bit = 0; bit < codeSize; bit += 1) {
      const absoluteBit = bitOffset + bit;
      value |= ((data[absoluteBit >>> 3]! >>> (absoluteBit & 7)) & 1) << bit;
    }
    bitOffset += codeSize;
    return value;
  }

  while (!ended) {
    const code = readCode();
    if (code === undefined) break;
    if (code === clearCode) {
      codeSize = minimumCodeSize + 1;
      nextCode = endCode + 1;
      previousCode = -1;
      continue;
    }
    if (code === endCode) {
      ended = true;
      break;
    }
    if (code >= 4096 || (code > nextCode && previousCode >= 0)) throw new Error('GIF LZW 码流无效');

    const inputCode = code;
    let stackSize = 0;
    let currentCode = code;
    if (currentCode === nextCode) {
      if (previousCode < 0) throw new Error('GIF LZW 首个码无效');
      stack[stackSize++] = firstCharacter;
      currentCode = previousCode;
    }
    while (currentCode >= clearCode) {
      if (currentCode >= nextCode || stackSize >= stack.length) throw new Error('GIF LZW 字典无效');
      stack[stackSize++] = suffix[currentCode]!;
      currentCode = prefix[currentCode]!;
    }
    if (currentCode >= clearCode || stackSize >= stack.length) throw new Error('GIF LZW 字典无效');
    firstCharacter = suffix[currentCode]!;
    stack[stackSize++] = firstCharacter;

    while (stackSize > 0) {
      if (outputOffset >= expected) throw new Error('GIF 解码像素超过帧范围');
      output[outputOffset++] = stack[--stackSize]!;
    }

    if (previousCode >= 0 && nextCode < 4096) {
      prefix[nextCode] = previousCode;
      suffix[nextCode] = firstCharacter;
      nextCode += 1;
      if (nextCode === (1 << codeSize) && codeSize < 12) codeSize += 1;
    }
    previousCode = inputCode;
  }

  if (!ended || outputOffset !== expected) throw new Error('GIF 帧像素数量无效');
  return output;
}

function deinterlace(indices: Uint8Array, width: number, height: number): Uint8Array {
  const rows = new Uint8Array(indices.length);
  const passes: Array<[number, number]> = [[0, 8], [4, 8], [2, 4], [1, 2]];
  let sourceRow = 0;
  for (const [start, step] of passes) {
    for (let y = start; y < height; y += step) {
      const sourceOffset = sourceRow * width;
      rows.set(indices.subarray(sourceOffset, sourceOffset + width), y * width);
      sourceRow += 1;
    }
  }
  return rows;
}

function applyPalette(
  canvas: Uint8Array,
  indices: Uint8Array,
  palette: Uint8Array,
  frame: { left: number; top: number; width: number; height: number },
  transparentIndex: number | undefined,
  screenWidth: number,
): void {
  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      const colorIndex = indices[y * frame.width + x]!;
      if (colorIndex === transparentIndex) continue;
      const colorOffset = colorIndex * 3;
      if (colorOffset + 2 >= palette.length) throw new Error('GIF 调色板索引越界');
      const canvasOffset = ((frame.top + y) * screenWidth + frame.left + x) * 4;
      canvas[canvasOffset] = palette[colorOffset]!;
      canvas[canvasOffset + 1] = palette[colorOffset + 1]!;
      canvas[canvasOffset + 2] = palette[colorOffset + 2]!;
      canvas[canvasOffset + 3] = 255;
    }
  }
}

export function decodeGifFrames(bytes: Uint8Array): GifFrame[] {
  const header = String.fromCharCode(...bytes.subarray(0, 6));
  if (header !== 'GIF87a' && header !== 'GIF89a') throw new Error('GIF 文件头无效');
  if (bytes.length < 13) throw new Error('GIF 逻辑屏幕描述被截断');
  const screenWidth = readWord(bytes, 6);
  const screenHeight = readWord(bytes, 8);
  const screenPixels = screenWidth * screenHeight;
  if (screenWidth === 0 || screenHeight === 0 || screenPixels > MAX_GIF_CANVAS_PIXELS) {
    throw new RangeError('GIF 画布尺寸超出限制');
  }
  const screenPacked = bytes[10]!;
  const hasGlobalPalette = (screenPacked & 0x80) !== 0;
  const backgroundIndex = bytes[11]!;
  const globalPaletteLength = hasGlobalPalette ? 3 * (1 << ((screenPacked & 0x07) + 1)) : 0;
  let offset = 13 + globalPaletteLength;
  if (offset > bytes.length) throw new Error('GIF 全局调色板被截断');
  const globalPalette = hasGlobalPalette ? bytes.subarray(13, offset) : new Uint8Array();
  const cursor = { offset };
  const canvas = new Uint8Array(screenPixels * 4);
  const backgroundOffset = backgroundIndex * 3;
  const hasBackgroundColor = backgroundOffset + 2 < globalPalette.length;
  if (hasBackgroundColor) {
    for (let pixel = 0; pixel < screenPixels; pixel += 1) {
      const target = pixel * 4;
      canvas[target] = globalPalette[backgroundOffset]!;
      canvas[target + 1] = globalPalette[backgroundOffset + 1]!;
      canvas[target + 2] = globalPalette[backgroundOffset + 2]!;
      canvas[target + 3] = 255;
    }
  }
  const frames: GifFrame[] = [];
  let totalFramePixels = 0;
  let graphicControl = { disposal: 0, transparentIndex: undefined as number | undefined };
  let previous: {
    disposal: number;
    transparentIndex: number | undefined;
    rect: { left: number; top: number; width: number; height: number };
    restore?: Uint8Array;
  } | undefined;

  while (cursor.offset < bytes.length) {
    const marker = bytes[cursor.offset++];
    if (marker === 0x3b) break;
    if (marker === 0x21) {
      const label = bytes[cursor.offset++];
      if (label === undefined) throw new Error('GIF 扩展块被截断');
      if (label === 0xf9) {
        const size = bytes[cursor.offset++];
        if (size !== 4 || cursor.offset + 5 > bytes.length) throw new Error('GIF 图形控制块无效');
        const packed = bytes[cursor.offset]!;
        cursor.offset += 3;
        const transparentIndex = bytes[cursor.offset]!;
        cursor.offset += 1;
        if (bytes[cursor.offset++] !== 0) throw new Error('GIF 图形控制块结束符无效');
        graphicControl = {
          disposal: (packed >>> 2) & 0x07,
          transparentIndex: packed & 0x01 ? transparentIndex : undefined,
        };
      } else {
        readSubBlocks(bytes, cursor);
      }
      continue;
    }
    if (marker !== 0x2c) throw new Error('GIF 图像分隔符无效');
    if (cursor.offset + 9 > bytes.length) throw new Error('GIF 图像描述符被截断');
    const left = readWord(bytes, cursor.offset);
    const top = readWord(bytes, cursor.offset + 2);
    const width = readWord(bytes, cursor.offset + 4);
    const height = readWord(bytes, cursor.offset + 6);
    const packed = bytes[cursor.offset + 8]!;
    cursor.offset += 9;
    if (width === 0 || height === 0 || left + width > screenWidth || top + height > screenHeight) {
      throw new Error('GIF 帧尺寸无效');
    }
    totalFramePixels += screenPixels;
    if (frames.length >= MAX_GIF_FRAME_COUNT || totalFramePixels > MAX_GIF_TOTAL_PIXELS) {
      throw new RangeError('GIF 动画帧数超出限制');
    }
    const hasLocalPalette = (packed & 0x80) !== 0;
    const paletteLength = hasLocalPalette ? 3 * (1 << ((packed & 0x07) + 1)) : 0;
    const palette = hasLocalPalette ? bytes.subarray(cursor.offset, cursor.offset + paletteLength) : globalPalette;
    if (hasLocalPalette) cursor.offset += paletteLength;
    if (palette.length === 0 || cursor.offset >= bytes.length) throw new Error('GIF 帧调色板无效');
    const minimumCodeSize = bytes[cursor.offset++]!;
    const compressed = readSubBlocks(bytes, cursor);
    let indices = decodeLzw(compressed, minimumCodeSize, width * height);
    if (packed & 0x40) indices = deinterlace(indices, width, height);

    if (previous?.disposal === 2) {
      for (let y = previous.rect.top; y < previous.rect.top + previous.rect.height; y += 1) {
        const start = (y * screenWidth + previous.rect.left) * 4;
        const end = (y * screenWidth + previous.rect.left + previous.rect.width) * 4;
        if (previous.transparentIndex === backgroundIndex || !hasBackgroundColor) {
          canvas.fill(0, start, end);
        } else {
          for (let target = start; target < end; target += 4) {
            canvas[target] = globalPalette[backgroundOffset]!;
            canvas[target + 1] = globalPalette[backgroundOffset + 1]!;
            canvas[target + 2] = globalPalette[backgroundOffset + 2]!;
            canvas[target + 3] = 255;
          }
        }
      }
    } else if (previous?.disposal === 3 && previous.restore) {
      canvas.set(previous.restore);
    }
    if (!previous && graphicControl.transparentIndex === backgroundIndex) canvas.fill(0);
    const restore = graphicControl.disposal === 3 ? canvas.slice() : undefined;
    applyPalette(canvas, indices, palette, { left, top, width, height }, graphicControl.transparentIndex, screenWidth);
    frames.push({ width: screenWidth, height: screenHeight, rgba: canvas.slice() });
    previous = {
      disposal: graphicControl.disposal,
      transparentIndex: graphicControl.transparentIndex,
      rect: { left, top, width, height },
      ...(restore === undefined ? {} : { restore }),
    };
    graphicControl = { disposal: 0, transparentIndex: undefined };
  }

  if (frames.length === 0) throw new Error('GIF 没有可解码的帧');
  return frames;
}

function grayscaleThumbnail(frame: GifFrame): Uint8Array {
  const gray = new Uint8Array(THUMBNAIL_SIZE * THUMBNAIL_SIZE);
  for (let y = 0; y < THUMBNAIL_SIZE; y += 1) {
    const sourceY = Math.min(frame.height - 1, Math.floor(((y + 0.5) * frame.height) / THUMBNAIL_SIZE));
    for (let x = 0; x < THUMBNAIL_SIZE; x += 1) {
      const sourceX = Math.min(frame.width - 1, Math.floor(((x + 0.5) * frame.width) / THUMBNAIL_SIZE));
      const offset = (sourceY * frame.width + sourceX) * 4;
      const alpha = frame.rgba[offset + 3]! / 255;
      const luma = frame.rgba[offset]! * 0.299
        + frame.rgba[offset + 1]! * 0.587
        + frame.rgba[offset + 2]! * 0.114;
      gray[y * THUMBNAIL_SIZE + x] = Math.round(luma * alpha + 255 * (1 - alpha));
    }
  }
  return gray;
}

function frameDifference(first: Uint8Array, second: Uint8Array): number {
  let difference = 0;
  for (let index = 0; index < first.length; index += 1) {
    difference += Math.abs(first[index]! - second[index]!);
  }
  return difference / first.length / 255;
}

export function selectGifFrames(frames: GifFrame[]): GifFrame[] {
  if (frames.length <= 1) return frames.slice(0, 1);
  const thumbnails = frames.map(grayscaleThumbnail);
  const differences: number[] = [];
  let totalChange = 0;
  for (let index = 1; index < thumbnails.length; index += 1) {
    const difference = frameDifference(thumbnails[index - 1]!, thumbnails[index]!);
    differences.push(difference);
    totalChange += difference;
  }
  if (totalChange / differences.length < MINIMUM_CHANGE) return frames.slice(0, 1);

  const cumulative = [0];
  for (const difference of differences) cumulative.push(cumulative[cumulative.length - 1]! + difference);
  const targets = [0, totalChange / 3, (totalChange * 2) / 3, totalChange];
  const selectedIndexes: number[] = [];
  for (const target of targets) {
    let selected = cumulative.findIndex((value) => value >= target);
    if (selected < 0) selected = cumulative.length - 1;
    if (!selectedIndexes.includes(selected)) selectedIndexes.push(selected);
  }
  return selectedIndexes.map((index) => frames[index]!);
}
