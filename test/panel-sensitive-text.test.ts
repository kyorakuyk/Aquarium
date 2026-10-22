import test from 'node:test';
import assert from 'node:assert/strict';
import { containsSensitiveText, redactSensitiveText } from '../src/core/impressions/sensitive-text.ts';

test('redacts labeled and opaque credentials while preserving surrounding Chinese', () => {
  const credentials = [
    'FAKE_TOKEN_VALUE_123456',
    'FAKE_BEARER_VALUE_123456',
    'sk-abc123def456ghi789',
  ];
  const result = redactSensitiveText(`token=${credentials[0]} Bearer ${credentials[1]} 今晚聊游戏 ${credentials.slice(2).join(' ')}`);
  for (const credential of credentials) assert.equal(result.includes(credential), false);
  assert.match(result, /今晚聊游戏 \[敏感内容已隐藏\]/);
});

test('leaves ordinary labels and product names unchanged', () => {
  assert.equal(redactSensitiveText('爱玩梗'), '爱玩梗');
  assert.equal(redactSensitiveText('深夜活跃'), '深夜活跃');
  assert.equal(redactSensitiveText('deepseek'), 'deepseek');
  assert.equal(redactSensitiveText('Aquarium'), 'Aquarium');
  assert.equal(redactSensitiveText('DeepSeek V4'), 'DeepSeek V4');
});

test('sensitive-text containment identifies labeled credentials', () => {
  assert.equal(containsSensitiveText('token=FAKE_TOKEN_VALUE_123456'), true);
  assert.equal(containsSensitiveText('今晚聊游戏'), false);
});
