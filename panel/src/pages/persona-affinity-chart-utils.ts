import type { PointerEvent as ReactPointerEvent } from 'react';
import { type AffinityLevel, type AffinityTiers } from '../../../src/core/affinity/core.ts';
import { affinityCurveValue, type AffinityCurveId, type AffinityCurveSetting } from '../../../src/core/affinity/curves.ts';

export const LEVEL_LABELS: Record<AffinityLevel, string> = {
  enemy: '仇人',
  loathe: '憎恶',
  dislike: '讨厌',
  uncomfortable: '不爽',
  distant: '冷淡',
  unfamiliar: '不熟',
  acquaintance: '认识',
  ordinary_friend: '普通朋友',
  more_than_friends: '朋友以上',
  lover: '恋人',
};
export const POSITIVE_NAMES = ['不熟', '认识', '普通朋友', '朋友以上', '恋人'];
export const NEGATIVE_NAMES = ['仇人', '憎恶', '讨厌', '不爽', '冷淡'];
export const PLOT = { left: 40, right: 656, top: 36, bottom: 236, width: 676, height: 280 } as const;
export const CURVE_PRESETS = [
  { id: 'default', label: '默认函数' },
  { id: 'flat', label: '平直 ×1' },
  { id: 'slow', label: '慢热' },
] as const;

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export function formatAffinity(value: number): string {
  return value < 0 ? `−${Math.abs(value)}` : String(value);
}

export function formatDelta(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  if (rounded === 0) return '0';
  return rounded < 0 ? `−${Math.abs(rounded).toFixed(1)}` : `+${rounded.toFixed(1)}`;
}

export function curvePath(curveId: AffinityCurveId, curve: AffinityCurveSetting, tiers: AffinityTiers, negative: boolean): string {
  const start = negative ? -100 : 0;
  return Array.from({ length: 151 }, (_, index) => {
    const ratio = index / 150;
    const affinity = start + ratio * 100;
    const x = PLOT.left + ratio * (PLOT.right - PLOT.left);
    const multiplier = affinityCurveValue(curveId, curve, affinity, tiers);
    const y = PLOT.bottom - (multiplier / 3) * (PLOT.bottom - PLOT.top);
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ');
}

export function pointFromEvent(event: ReactPointerEvent<SVGSVGElement>): { x: number; y: number } | undefined {
  const matrix = event.currentTarget.getScreenCTM();
  if (!matrix) return undefined;
  const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
  return { x: point.x, y: point.y };
}

export function solvePointOffset(
  curveId: AffinityCurveId,
  curve: AffinityCurveSetting,
  index: number,
  affinity: number,
  targetValue: number,
  tiers: AffinityTiers,
): AffinityCurveSetting {
  const points = curve.points.map((point) => ({ ...point }));
  let lower = -3;
  let upper = 3;
  for (let iteration = 0; iteration < 28; iteration += 1) {
    const candidate = (lower + upper) / 2;
    points[index] = { ...points[index]!, dy: candidate };
    const value = affinityCurveValue(curveId, { ...curve, points }, affinity, tiers);
    if (value < targetValue) lower = candidate;
    else upper = candidate;
  }
  points[index] = { ...points[index]!, dy: Math.round(((lower + upper) / 2) * 100) / 100 };
  return { ...curve, points };
}
