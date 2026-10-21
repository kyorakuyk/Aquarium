import assert from 'node:assert/strict';
import test from 'node:test';
import { describeError } from '../src/app/error-description.ts';

test('error summaries include a safe failure stage and metadata, never the raw message', () => {
  const error = Object.assign(new Error('用户聊天内容不应进入日志'), {
    code: 'ECONNRESET',
    hostname: 'provider.example',
  });

  const summary = describeError(error, '调用模型');
  assert.match(summary, /^Error\b/u);
  assert.match(summary, /stage=调用模型/u);
  assert.match(summary, /code=ECONNRESET/u);
  assert.match(summary, /host=provider\.example/u);
  assert.doesNotMatch(summary, /用户聊天内容/u);
});

test('error summaries keep unknown failures safe while retaining their stage', () => {
  assert.equal(describeError('私密文本', '面板请求'), '未知错误 stage=面板请求');
});
