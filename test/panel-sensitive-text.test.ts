import test from 'node:test';
import assert from 'node:assert/strict';
import { redactSensitiveText } from '../panel/src/sensitive-text.ts';

test('redacts labeled and opaque credentials while preserving surrounding Chinese', () => {
  const credentials = [
    'FAKE_TOKEN_VALUE_123456',
    'FAKE_BEARER_VALUE_123456',
    'A1b2C3d4E5f6G7h8J9k0Lm',
    'ABCDEFGHIJKLMNQRST',
    'K9m4R2p8T1v6',
    'Q7m2L9p4',
  ];
  const result = redactSensitiveText(`token=${credentials[0]} Bearer ${credentials[1]} 今晚聊游戏 ${credentials.slice(2).join(' ')}`);
  for (const credential of credentials) assert.equal(result.includes(credential), false);
  assert.match(result, /今晚聊游戏 \[敏感内容已隐藏\]/);
});

test('leaves ordinary short labels unchanged', () => {
  assert.equal(redactSensitiveText('爱玩梗'), '爱玩梗');
  assert.equal(redactSensitiveText('深夜活跃'), '深夜活跃');
});
