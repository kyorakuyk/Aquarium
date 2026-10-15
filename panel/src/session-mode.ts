import type { ModeScheduleEntry, SessionMode } from './api.ts';

export const SESSION_MODE_OPTIONS: readonly { mode: SessionMode; title: string; note: string }[] = [
  { mode: 'mention_only', title: '只在被叫时', note: '需要被叫到' },
  { mode: 'natural', title: '自然', note: '偶尔自然接话' },
  { mode: 'active', title: '积极', note: '更积极地参与' },
  { mode: 'busy', title: '忙碌', note: '回复更少、更短' },
];

export type ModeScheduleDrafts = ReadonlyMap<string, readonly ModeScheduleEntry[]>;
export type ModeScheduleRowKeys = ReadonlyMap<string, readonly string[]>;

export function getModeScheduleRowKeys(
  rowKeys: ModeScheduleRowKeys,
  sessionId: string,
  entries: readonly ModeScheduleEntry[],
): readonly string[] {
  const existing = rowKeys.get(sessionId);
  if (existing && existing.length === entries.length && new Set(existing).size === existing.length) return existing;
  return entries.map((_, index) => `${sessionId}:row:${index}`);
}

export function getModeScheduleDraft(
  drafts: ModeScheduleDrafts,
  sessionId: string,
  effective: readonly ModeScheduleEntry[],
): readonly ModeScheduleEntry[] {
  return drafts.get(sessionId) ?? effective;
}

export function changeModeScheduleDraft(
  drafts: ModeScheduleDrafts,
  sessionId: string,
  effective: readonly ModeScheduleEntry[],
  change: (entries: readonly ModeScheduleEntry[]) => ModeScheduleEntry[],
): Map<string, readonly ModeScheduleEntry[]> {
  return new Map(drafts).set(sessionId, change(getModeScheduleDraft(drafts, sessionId, effective)));
}

export function discardModeScheduleDraft(drafts: ModeScheduleDrafts, sessionId: string): Map<string, readonly ModeScheduleEntry[]> {
  const next = new Map(drafts);
  next.delete(sessionId);
  return next;
}

export function addModeScheduleEntry(entries: readonly ModeScheduleEntry[]): ModeScheduleEntry[] {
  return [...entries, { from: '09:00', to: '17:00', mode: 'natural' }];
}

export function updateModeScheduleEntry(
  entries: readonly ModeScheduleEntry[],
  index: number,
  changes: Partial<ModeScheduleEntry>,
): ModeScheduleEntry[] {
  return entries.map((entry, currentIndex) => currentIndex === index ? { ...entry, ...changes } : entry);
}

export function removeModeScheduleEntry(entries: readonly ModeScheduleEntry[], index: number): ModeScheduleEntry[] {
  return entries.filter((_, currentIndex) => currentIndex !== index);
}
