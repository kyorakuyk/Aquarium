import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanReply } from '../src/core/text.ts';

test('cleanReply 只去成对格式标记并处理已知昵称前缀', () => {
  assert.equal(cleanReply('**小鱼：**\n> 你好，*朋友*！', ['小鱼']), '你好，*朋友*！');
});

test('cleanReply 保留聊天文字中的单个波浪线和下划线', () => {
  assert.equal(cleanReply('好的~明天见 (＾_＾)'), '好的~明天见 (＾_＾)');
  assert.equal(cleanReply('*拍拍*'), '*拍拍*');
  assert.equal(cleanReply('*'), '*');
  assert.equal(cleanReply('_'), '_');
  assert.equal(cleanReply('~'), '~');
});

test('cleanReply 只移除成对的粗体和行内代码标记', () => {
  assert.equal(cleanReply('**重点** __强调__ `代码` ~~删除~~'), '重点 __强调__ 代码 ~~删除~~');
});

test('cleanReply 保留中文聊天中的双波浪线和双下划线', () => {
  assert.equal(cleanReply('好呀~~那走吧~~'), '好呀~~那走吧~~');
  assert.equal(cleanReply('冲冲冲~~ 今晚~~'), '冲冲冲~~ 今晚~~');
  assert.equal(cleanReply('好__耶__'), '好__耶__');
  assert.equal(cleanReply('(__) 趴下了'), '(__) 趴下了');
});

test('cleanReply 保留链接文字并移除标题、列表和行内代码标记', () => {
  assert.equal(
    cleanReply('### 标题\n- 这是 **重点**，看 [页面](https://example.com)。`结束`'),
    '标题\n这是 重点，看 页面。结束',
  );
});

test('cleanReply 不误删未配置昵称后的冒号', () => {
  assert.equal(cleanReply('服务端：已恢复', ['小鱼']), '服务端：已恢复');
});

test('cleanReply 将只有格式标记的回复清为空', () => {
  assert.equal(cleanReply('  **   ', []), '');
});
