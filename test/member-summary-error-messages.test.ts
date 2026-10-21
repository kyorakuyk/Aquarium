import assert from 'node:assert/strict';
import test from 'node:test';

test('member summary errors are shown in Chinese without exposing raw API messages', async () => {
  const moduleUrl = new URL('../panel/src/member-summary-errors.ts', import.meta.url).href;
  const messages = await import(moduleUrl).catch(() => undefined) as {
    memberSummaryErrorMessage?: (reason: unknown, operation: 'read' | 'save') => string;
  } | undefined;
  const format = messages?.memberSummaryErrorMessage;

  assert.equal(
    typeof format === 'function' ? format(new Error('Member summary target not found'), 'save') : undefined,
    '该成员当前没有可编辑的印象标签，请刷新后重试。',
  );
  assert.equal(format?.(new Error('Failed to fetch'), 'read'), '读取一句话印象失败，请稍后重试。');
  assert.equal(format?.(new Error('登录已失效'), 'save'), '登录已失效');
});
