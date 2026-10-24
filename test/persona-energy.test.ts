import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateRecoveryTo80 } from '../panel/src/pages/persona-energy-utils.ts';

test('恢复估算按来源和倍率缩放，并安全处理不恢复状态', () => {
  const normal = estimateRecoveryTo80(0.3, 'inner', false, 1);
  const triple = estimateRecoveryTo80(0.3, 'inner', false, 3);
  assert.equal(normal.status, 'ready');
  assert.equal(triple.status, 'ready');
  if (normal.status !== 'ready' || triple.status !== 'ready') return;
  assert.ok(Number.isFinite(normal.minutes) && normal.minutes > 0);
  assert.ok(Math.abs(triple.minutes * 3 - normal.minutes) < 1e-9);
  assert.equal(estimateRecoveryTo80(0.3, 'inner', true, 1).status, 'unavailable');
  assert.equal(estimateRecoveryTo80(0.3, 'outer', false, 0).status, 'unavailable');
  assert.equal(estimateRecoveryTo80(0.8, 'inner', true, 0).status, 'reached');
});
