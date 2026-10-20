import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyExtractFailure, extractFailureLabel } from '../src/core/impressions/extract-error.ts';

test('extract errors classify HTTP, timeout, network, and other cases without exposing body text', () => {
  const cases: Array<[unknown, string]> = [
    [Object.assign(new Error('private prompt text'), { name: 'APIConnectionTimeoutError' }), '模型超时'],
    [Object.assign(new Error('opaque'), { code: 'ECONNRESET' }), '网络错误'],
    [Object.assign(new Error('opaque'), { status: 429 }), 'HTTP 429'],
    [Object.assign(new Error('opaque'), { name: 'AbortError', code: 'ABORT_ERR' }), '模型超时'],
    [Object.assign(new Error('opaque'), { code: 'ENOTFOUND' }), '网络错误'],
    [new Error('opaque'), '其他错误'],
  ];

  for (const [error, label] of cases) {
    assert.equal(extractFailureLabel(classifyExtractFailure(error)), label);
  }
});
