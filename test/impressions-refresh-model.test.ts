import assert from 'node:assert/strict';
import test from 'node:test';
import {
  shouldRefreshCompletedExtraction,
  shouldRefreshHistoryImport,
} from '../panel/src/impressions-refresh-model.ts';

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
