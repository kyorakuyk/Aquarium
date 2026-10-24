import { DEFAULT_AFFINITY_TIERS, type AffinityTiers } from './core.ts';

export type AffinityCurveId = 'posGain' | 'posLoss' | 'negGain' | 'negLoss';
export type AffinityCurvePreset = 'default' | 'flat' | 'slow';

export interface AffinityCurvePoint {
  x: number;
  dy: number;
}

export interface AffinityCurveSetting {
  preset: AffinityCurvePreset;
  points: AffinityCurvePoint[];
}

export type AffinityCurveSet = Record<AffinityCurveId, AffinityCurveSetting>;
export type AffinityCurveOverrides = Partial<Record<AffinityCurveId, AffinityCurveSetting>>;

export const AFFINITY_CURVE_IDS: readonly AffinityCurveId[] = ['posGain', 'posLoss', 'negGain', 'negLoss'];
export const DEFAULT_AFFINITY_CURVES: AffinityCurveSet = {
  posGain: { preset: 'default', points: [] },
  posLoss: { preset: 'default', points: [] },
  negGain: { preset: 'default', points: [] },
  negLoss: { preset: 'default', points: [] },
};

interface Point {
  x: number;
  y: number;
}

const DEFAULT_KNOTS: Record<AffinityCurveId, Point[]> = {
  posGain: [
    { x: 0, y: 0.5 }, { x: 12, y: 0.65 }, { x: 23, y: 1.9 }, { x: 35, y: 1.55 },
    { x: 47.5, y: 1 }, { x: 55, y: 0.55 }, { x: 60, y: 0.1 }, { x: 64, y: 0.55 },
    { x: 72.5, y: 0.85 }, { x: 100, y: 0.75 },
  ],
  posLoss: [
    { x: 0, y: 1.25 }, { x: 15, y: 1.1 }, { x: 25, y: 1 }, { x: 47.5, y: 0.8 },
    { x: 72.5, y: 0.9 }, { x: 85, y: 1.05 }, { x: 100, y: 1.35 },
  ],
  negGain: [
    { x: -100, y: 0.03 }, { x: -85, y: 0.05 }, { x: -60, y: 0.08 }, { x: -47.5, y: 0.25 },
    { x: -35, y: 0.45 }, { x: -15, y: 0.75 }, { x: 0, y: 1 },
  ],
  negLoss: [
    { x: -100, y: 0.5 }, { x: -85, y: 0.8 }, { x: -72.5, y: 1 }, { x: -47.5, y: 1.35 },
    { x: -25, y: 1.2 }, { x: 0, y: 1 },
  ],
};

function spline(points: readonly Point[], x: number): number {
  if (points.length === 1) return points[0]!.y;
  const h: number[] = [];
  const d: number[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const distance = points[index + 1]!.x - points[index]!.x;
    h.push(distance || 1e-6);
    d.push((points[index + 1]!.y - points[index]!.y) / h[index]!);
  }
  const slopes = [d[0]!];
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = d[index - 1]!;
    const current = d[index]!;
    slopes.push(previous * current <= 0
      ? 0
      : (h[index - 1]! + h[index]!) * 3
        / ((2 * h[index]! + h[index - 1]!) / previous + (h[index]! + 2 * h[index - 1]!) / current));
  }
  slopes.push(d[d.length - 1]!);

  let segment = 0;
  while (segment < points.length - 2 && x > points[segment + 1]!.x) segment += 1;
  const t = Math.max(0, Math.min(1, (x - points[segment]!.x) / h[segment]!));
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * points[segment]!.y
    + (t3 - 2 * t2 + t) * h[segment]! * slopes[segment]!
    + (-2 * t3 + 3 * t2) * points[segment + 1]!.y
    + (t3 - t2) * h[segment]! * slopes[segment + 1]!;
}

function baseValue(curveId: AffinityCurveId, preset: AffinityCurvePreset, ratio: number, affinity: number): number {
  if (preset === 'flat') return 1;
  if (preset === 'slow') return 0.35 + 1.15 / (1 + Math.exp(-(ratio - 0.55) / 0.09));
  return spline(DEFAULT_KNOTS[curveId], affinity);
}

function localOffset(points: readonly AffinityCurvePoint[], ratio: number): number {
  if (points.length === 0) return 0;
  const ordered = [...points].sort((left, right) => left.x - right.x);
  const radius = 0.22;
  const offsets: Point[] = [];
  ordered.forEach((point, index) => {
    const previous = ordered[index - 1];
    const next = ordered[index + 1];
    if (point.x - radius > 0 && (!previous || previous.x < point.x - 2 * radius)) {
      offsets.push({ x: point.x - radius, y: 0 });
    }
    offsets.push({ x: point.x, y: point.dy });
    if (point.x + radius < 1 && (!next || next.x > point.x + 2 * radius)) {
      offsets.push({ x: point.x + radius, y: 0 });
    }
  });
  if (offsets[0]!.x > 0.005) offsets.unshift({ x: 0, y: 0 });
  if (offsets[offsets.length - 1]!.x < 0.995) offsets.push({ x: 1, y: 0 });
  return spline(offsets, ratio);
}

export function affinityCurveValue(
  curveId: AffinityCurveId,
  curve: AffinityCurveSetting,
  affinity: number,
  tiers: AffinityTiers = DEFAULT_AFFINITY_TIERS,
): number {
  void tiers;
  const isNegative = curveId.startsWith('neg');
  const ratio = Math.max(0, Math.min(1, isNegative ? (affinity + 100) / 100 : affinity / 100));
  const baseline = baseValue(curveId, curve.preset, ratio, affinity);
  return Math.max(0, Math.min(3, baseline + localOffset(curve.points, ratio)));
}

export function resolveAffinityCurves(
  defaults: AffinityCurveSet,
  overrides?: AffinityCurveOverrides,
): AffinityCurveSet {
  return Object.fromEntries(AFFINITY_CURVE_IDS.map((curveId) => {
    const fallback = defaults[curveId];
    const override = overrides?.[curveId];
    return [curveId, {
      preset: override?.preset ?? fallback.preset,
      points: (override?.points ?? fallback.points).map((point) => ({ ...point })),
    }];
  })) as AffinityCurveSet;
}

export function affinityMultiplier(
  value: number,
  delta: number,
  curves: AffinityCurveSet,
  tiers: AffinityTiers = DEFAULT_AFFINITY_TIERS,
): number {
  const curveId: AffinityCurveId = value < 0
    ? delta >= 0 ? 'negGain' : 'negLoss'
    : delta >= 0 ? 'posGain' : 'posLoss';
  return affinityCurveValue(curveId, curves[curveId], value, tiers);
}
