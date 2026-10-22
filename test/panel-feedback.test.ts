import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatSavedAt,
  personalImpressionsErrorText,
  showEmptyPersonalImpressions,
} from '../panel/src/panel-feedback.ts';

test('印象页把 404 转成中文并隐藏空状态', () => {
  const message = personalImpressionsErrorText('Not found');
  assert.match(message, /重启/u);
  assert.equal(showEmptyPersonalImpressions(false, message, 0), false);
});

test('印象页保留其他错误，只在成功空结果时显示空状态', () => {
  assert.equal(personalImpressionsErrorText('网络暂不可用'), '网络暂不可用');
  assert.equal(showEmptyPersonalImpressions(false, '', 0), true);
  assert.equal(showEmptyPersonalImpressions(true, '', 0), false);
  assert.equal(showEmptyPersonalImpressions(false, '', 1), false);
});

test('保存回执使用本地两位制时分', () => {
  assert.equal(formatSavedAt(new Date(2026, 0, 2, 9, 7)), '09:07');
});
