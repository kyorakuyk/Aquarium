import assert from 'node:assert/strict';
import test from 'node:test';
import { activityDecisionMetrics } from '../panel/src/decision-metrics.ts';

test('formats available activity scores as labeled percentages in pipeline order', () => {
  assert.deepEqual(activityDecisionMetrics({ p0: 0.25, probability: 0.8, threshold: 0.5, trigger: 'proactive' }), [
    { key: 'p0', label: '粗筛分数 p0', value: 0.25, display: '25.0%' },
    { key: 'probability', label: '判断概率', value: 0.8, display: '80.0%' },
    { key: 'threshold', label: '动态阈值', value: 0.5, display: '50.0%' },
  ]);
});

test('omits unavailable, inherited, malformed, and out-of-range activity scores', () => {
  const inherited = Object.create({ probability: 0.9 }) as Record<string, unknown>;
  inherited.p0 = '0.4';
  inherited.threshold = 1.1;

  assert.deepEqual(activityDecisionMetrics(inherited), []);
  assert.deepEqual(activityDecisionMetrics({ probability: Number.NaN, p0: -0.1, threshold: 0 }), [
    { key: 'threshold', label: '动态阈值', value: 0, display: '0.0%' },
  ]);
  assert.deepEqual(activityDecisionMetrics(null), []);
  assert.deepEqual(activityDecisionMetrics(['0.5']), []);
});
