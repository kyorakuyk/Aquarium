export function sidebarEnergyLabel(enabled: boolean, energy: number | null): string {
  if (!enabled) return '在线';
  if ((energy ?? 0) >= 0.6) return '精神不错';
  if ((energy ?? 0) >= 0.35) return '有点累';
  return '有点困';
}
