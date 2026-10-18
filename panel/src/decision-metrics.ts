export type ActivityDecisionMetricKey = 'p0' | 'probability' | 'threshold';

export interface ActivityDecisionMetric {
  key: ActivityDecisionMetricKey;
  label: string;
  value: number;
  display: string;
}

const metricLabels: ReadonlyArray<[ActivityDecisionMetricKey, string]> = [
  ['p0', '粗筛分数 p0'],
  ['probability', '判断概率'],
  ['threshold', '动态阈值'],
];

export function activityDecisionMetrics(detail: unknown): ActivityDecisionMetric[] {
  if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) return [];

  const record = detail as Record<string, unknown>;
  return metricLabels.flatMap(([key, label]) => {
    const value = Object.hasOwn(record, key) ? record[key] : undefined;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return [];
    return [{ key, label, value, display: `${(value * 100).toFixed(1)}%` }];
  });
}
