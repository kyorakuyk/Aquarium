import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanReply } from '../src/core/text.ts';

test('cleanReply 去掉 Markdown 格式和已知昵称前缀', () => {
  assert.equal(cleanReply('**小鱼：**\n> 你好，*朋友*！', ['小鱼']), '你好，朋友！');
});

test('cleanReply 保留链接文字并移除标题、列表和行内代码标记', () => {
  assert.equal(
    cleanReply('### 标题\n- 这是 **重点**，看 [页面](https://example.com)。`结束`'),
    '标题\n这是 重点，看 页面。结束',
  );
});

test('cleanReply 不误删未配置昵称后的冒号并将纯格式清成空串', () => {
  assert.equal(cleanReply('服务端：已恢复', ['小鱼']), '服务端：已恢复');
  assert.equal(cleanReply('  **   ', []), '');
});
