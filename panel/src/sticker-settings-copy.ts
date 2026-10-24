export type StickerRatioKey = 'maxRatio' | 'onlyStickerRatio';

export const stickerRatioCopy: Record<StickerRatioKey, { label: string; description: string }> = {
  maxRatio: {
    label: '带表情回复占比上限',
    description: '过去 2 小时内，带表情回复占比达到此值后会暂停提供表情候选。',
  },
  onlyStickerRatio: {
    label: '纯表情回复占比上限',
    description: '过去 2 小时内，纯表情回复占比达到此值后会拦截纯表情回复。',
  },
};

export function ratioToPercent(value: number): number {
  return Math.round(value * 100);
}

export function percentToRatio(value: number): number {
  return value / 100;
}
