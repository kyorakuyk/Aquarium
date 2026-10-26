import assert from 'node:assert/strict';
import test from 'node:test';
import { describeError } from '../src/app/error-description.ts';

test('error summaries include a safe failure stage and metadata, never the raw message', () => {
  class ProviderConnectionError extends Error {}
  const cause = Object.assign(new Error('底层聊天内容不应进入日志'), {
    name: 'SocketError',
    code: 'ECONNRESET',
  });
  const error = Object.assign(new ProviderConnectionError('用户聊天内容不应进入日志'), {
    name: 'APIConnectionError',
    status: 503,
    code: 'EHOSTUNREACH',
    hostname: 'provider.example',
    cause,
  });

  const summary = describeError(error, '调用模型');
  assert.equal(
    summary,
    'APIConnectionError stage=调用模型 status=503 code=EHOSTUNREACH constructor=ProviderConnectionError causeName=SocketError causeCode=ECONNRESET host=provider.example',
  );
  assert.doesNotMatch(summary, /用户聊天内容/u);
  assert.doesNotMatch(summary, /底层聊天内容/u);
});

test('error summaries keep unknown failures safe while retaining their stage', () => {
  assert.equal(describeError('私密文本', '面板请求'), '未知错误 stage=面板请求');
});
