import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const iconDirectory = path.resolve('assets', 'tray');
const iconNames = ['teal.ico', 'yellow.ico', 'red.ico'];

test('三个状态图标都是包含 16px 与 32px 帧的 ICO 文件', () => {
  for (const iconName of iconNames) {
    const iconPath = path.join(iconDirectory, iconName);
    const icon = fs.readFileSync(iconPath);
    assert.equal(icon.readUInt16LE(0), 0, `${iconName} 保留字段`);
    assert.equal(icon.readUInt16LE(2), 1, `${iconName} 类型字段`);
    const imageCount = icon.readUInt16LE(4);
    assert.equal(imageCount, 2, `${iconName} 帧数`);

    const sizes: number[] = [];
    for (let index = 0; index < imageCount; index += 1) {
      const entryOffset = 6 + index * 16;
      const size = icon.readUInt8(entryOffset) || 256;
      const height = icon.readUInt8(entryOffset + 1) || 256;
      const imageLength = icon.readUInt32LE(entryOffset + 8);
      const imageOffset = icon.readUInt32LE(entryOffset + 12);
      assert.equal(height, size, `${iconName} 第 ${index} 帧高度`);
      assert.ok(imageLength > 40, `${iconName} 第 ${index} 帧图像数据非空`);
      assert.ok(imageOffset + imageLength <= icon.length, `${iconName} 第 ${index} 帧位于文件范围内`);
      sizes.push(size);
    }
    assert.deepEqual(sizes.sort((left, right) => left - right), [16, 32]);
  }
});
