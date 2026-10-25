import assert from 'node:assert/strict';
import test from 'node:test';
import { extractAsides } from '../src/core/shared/inner-voice.ts';

test('full 保留并记录整行旁白与句末长旁白', () => {
  const text = [
    '（她发抖）',
    '我说好了。（她的心跳越来越快，手心也全是汗）',
    '普通括号樽见（她初中朋友）',
  ].join('\n');

  assert.deepEqual(extractAsides(text, 'full'), {
    spoken: text,
    asides: ['（她发抖）', '（她的心跳越来越快，手心也全是汗）'],
  });
});

test('light 最多保留一个八字内短动作，其余合格旁白转入心声', () => {
  const text = [
    '（捂脸）',
    '',
    '（小声）',
    '（紧张到说不出话，只能看着屏幕发呆）',
    '这句结束了.(心跳快得像要蹦出来)',
    '普通括号樽见（她初中朋友）',
  ].join('\n');

  assert.deepEqual(extractAsides(text, 'light'), {
    spoken: '（捂脸）\n\n这句结束了.\n普通括号樽见（她初中朋友）',
    asides: ['（小声）', '（紧张到说不出话，只能看着屏幕发呆）', '(心跳快得像要蹦出来)'],
  });
});

test('hidden 移除判定为旁白的括号内容，保留句中说明性括号并清理空行', () => {
  const text = [
    '她提到樽见（她初中朋友）了。接着说。',
    '',
    '（小声）',
    '行。(这是比较长的旁白，长度已经超过九个字)',
  ].join('\n');

  assert.deepEqual(extractAsides(text, 'hidden'), {
    spoken: '她提到樽见（她初中朋友）了。接着说。\n\n行。',
    asides: ['（小声）', '(这是比较长的旁白，长度已经超过九个字)'],
  });
});
