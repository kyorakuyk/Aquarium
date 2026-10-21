import assert from 'node:assert/strict';
import test from 'node:test';
import {
  shouldRefreshCompletedExtraction,
  shouldRefreshHistoryImport,
} from '../panel/src/impressions-refresh-model.ts';
import * as impressionsRefreshModel from '../panel/src/impressions-refresh-model.ts';

test('历史导入任何终态只刷新对应群', () => {
  for (const phase of ['done', 'cancelled', 'expired', 'error']) {
    assert.equal(shouldRefreshHistoryImport(phase, 'group:1:10', 'group:1:10'), true, phase);
  }
  for (const phase of ['fetching', 'extracting', 'awaiting_confirmation']) {
    assert.equal(shouldRefreshHistoryImport(phase, 'group:1:10', 'group:1:10'), false, phase);
  }
  assert.equal(shouldRefreshHistoryImport('done', 'group:1:10', 'group:1:11'), false);
});

test('自动提取完成时间晚于视图读取起点时需要补刷新', () => {
  assert.equal(shouldRefreshCompletedExtraction(200, 100), true);
  assert.equal(shouldRefreshCompletedExtraction(100, 100), true);
  assert.equal(shouldRefreshCompletedExtraction(null, 100), false);
});

test('旧标签整理失败状态显示明确的重试提示', () => {
  const tagClassificationStatusText = Reflect.get(impressionsRefreshModel, 'tagClassificationStatusText') as (
    status: { state: string; processed: number; total: number } | undefined,
  ) => string | undefined;

  assert.equal(typeof tagClassificationStatusText, 'function');
  if (typeof tagClassificationStatusText !== 'function') return;
  assert.equal(tagClassificationStatusText({ state: 'error', processed: 4, total: 9 }), '上次整理失败，可重试');
  assert.equal(tagClassificationStatusText({ state: 'running', processed: 4, total: 9 }), '正在整理旧标签：4 / 9。');
  assert.equal(tagClassificationStatusText({ state: 'completed', processed: 9, total: 9 }), undefined);
});
