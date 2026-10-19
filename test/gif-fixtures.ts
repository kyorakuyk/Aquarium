export function onePixelGif(indices: number[]): Uint8Array {
  const palette = [0, 40, 80, 120, 255, 20, 60, 100];
  const bytes = [
    ...new TextEncoder().encode('GIF89a'),
    1, 0, 1, 0, 0x82, 0, 0,
    ...palette.flatMap((value) => [value, value, value]),
  ];
  for (const index of indices) {
    if (!Number.isSafeInteger(index) || index < 0 || index >= palette.length) throw new RangeError('调色板索引无效');
    const codes = [8, index, 9];
    let packedByte = 0;
    let bitOffset = 0;
    const compressed: number[] = [];
    for (const code of codes) {
      for (let bit = 0; bit < 4; bit += 1) {
        packedByte |= ((code >>> bit) & 1) << bitOffset;
        bitOffset += 1;
        if (bitOffset === 8) {
          compressed.push(packedByte);
          packedByte = 0;
          bitOffset = 0;
        }
      }
    }
    if (bitOffset > 0) compressed.push(packedByte);
    bytes.push(0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 3, compressed.length, ...compressed, 0);
  }
  bytes.push(0x3b);
  return Uint8Array.from(bytes);
}
