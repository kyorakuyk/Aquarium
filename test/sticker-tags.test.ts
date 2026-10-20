import assert from 'node:assert/strict';
import test from 'node:test';
import { removeStickerTag } from '../panel/src/sticker-types.ts';

test('移除指定表情标签并保留其他标签的顺序', () => {
  assert.deepEqual(removeStickerTag(['开心', '无奈', '开心'], '开心'), ['无奈']);
  assert.deepEqual(removeStickerTag(['无奈'], 'missing'), ['无奈']);
});
