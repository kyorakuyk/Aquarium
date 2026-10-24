export type EnergySource = 'inner' | 'outer' | 'mixed';
export type RecoveryEstimate = { status: 'ready'; minutes: number } | { status: 'reached' } | { status: 'unavailable' };

export function baseHalfLifeHours(source: EnergySource, company: boolean): number | null {
  if (source === 'inner') return company ? null : 2;
  if (source === 'outer') return company ? 2 : 8;
  return 4;
}

export function estimateRecoveryTo80(
  reserve: number,
  source: EnergySource,
  company: boolean,
  multiplier: number,
): RecoveryEstimate {
  if (!Number.isFinite(reserve) || !Number.isFinite(multiplier)) return { status: 'unavailable' };
  const water = Math.max(0, Math.min(1, reserve));
  if (water >= 0.8) return { status: 'reached' };
  const baseHours = baseHalfLifeHours(source, company);
  const rate = Math.max(0, Math.min(3, multiplier));
  if (baseHours === null || rate === 0) return { status: 'unavailable' };
  const minutes = (baseHours / rate) * 60 * Math.log2((1 - water) / 0.2);
  return Number.isFinite(minutes) && minutes >= 0 ? { status: 'ready', minutes } : { status: 'unavailable' };
}

export function formatHalfLife(baseHours: number | null, multiplier: number): string {
  if (baseHours === null) return '此来源下不回能';
  if (multiplier <= 0) return '倍率为 0，不回能';
  return `半衰期 ${(baseHours / multiplier).toFixed(1)} 小时`;
}

export function formatRecoveryEstimate(
  estimate: RecoveryEstimate,
  source: EnergySource,
  company: boolean,
  multiplier: number,
): string {
  if (estimate.status === 'reached') return '当前水位已达到 80%';
  if (estimate.status === 'unavailable') {
    if (source === 'inner' && company) return '向内来源有人陪伴时不回能';
    if (multiplier <= 0) return '倍率为 0，不会恢复到 80%';
    return '暂时无法估算';
  }
  const rounded = Math.round(estimate.minutes);
  const hours = Math.floor(rounded / 60);
  const minutes = rounded % 60;
  if (hours === 0) return `约 ${minutes} 分钟`;
  return minutes === 0 ? `约 ${hours} 小时` : `约 ${hours} 小时 ${minutes} 分钟`;
}
