export interface StickerView {
  id: number;
  account: number;
  emojiId: string;
  md5: string;
  descQq: string;
  descAi: string;
  tags: string[];
  enabled: boolean;
  missing: boolean;
  useCount: number;
  lastUsedAt: number | null;
  descriptionAttempts: number;
  createdAt: number;
  updatedAt: number;
  imageUrl: string | null;
}

export interface StickerListView {
  stickers: StickerView[];
  lastSyncAt: number | null;
}

export interface StickerSettings {
  enabled: boolean;
  maxRatio: number;
  onlyStickerRatio: number;
  cooldownSec: number;
  candidates: number;
}

export type StickerFilter = 'all' | 'enabled' | 'undescribed' | 'missing';

export const stickerFilters: Array<{ id: StickerFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'enabled', label: '已启用' },
  { id: 'undescribed', label: '未描述' },
  { id: 'missing', label: '已移除' },
];

export function formatStickerTime(value: number | null): string {
  if (value === null) return '尚未同步';
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function stickerTagLength(value: string): number {
  return Array.from(value.trim()).length;
}

export function removeStickerTag(tags: string[], tag: string): string[] {
  return tags.filter((current) => current !== tag);
}
