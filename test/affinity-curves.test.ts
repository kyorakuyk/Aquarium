import assert from 'node:assert/strict';
import test from 'node:test';
import {
  affinityCurveValue,
  DEFAULT_AFFINITY_CURVES,
  type AffinityCurveSetting,
} from '../src/core/affinity/curves.ts';

const flat: AffinityCurveSetting = { preset: 'flat', points: [] };

test('好感曲线保留四条默认锚点并只在局部插值点附近偏移', () => {
  assert.ok(Math.abs(affinityCurveValue('posGain', DEFAULT_AFFINITY_CURVES.posGain, 60) - 0.1) < 1e-9);
  assert.ok(Math.abs(affinityCurveValue('negGain', DEFAULT_AFFINITY_CURVES.negGain, -60) - 0.08) < 1e-9);
  assert.equal(affinityCurveValue('posLoss', flat, 50), 1);

  const local: AffinityCurveSetting = { preset: 'flat', points: [{ x: 0.5, dy: 0.6 }] };
  assert.ok(Math.abs(affinityCurveValue('posGain', local, 50) - 1.6) < 1e-9);
  assert.ok(Math.abs(affinityCurveValue('posGain', local, 28) - 1) < 1e-9);
  assert.ok(Math.abs(affinityCurveValue('posGain', local, 72) - 1) < 1e-9);
});
