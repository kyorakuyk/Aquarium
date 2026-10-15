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

export async function saveModeScheduleDraft(
  save: () => Promise<unknown>,
  discardDraft: () => void,
  refresh: () => Promise<void>,
): Promise<void> {
  await save();
  discardDraft();
  await refresh();
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

export function createModeScheduleEntryChangeFromInput(
  event: { currentTarget: { value: string } },
  index: number,
  field: keyof ModeScheduleEntry,
): (entries: readonly ModeScheduleEntry[]) => ModeScheduleEntry[] {
  const value = event.currentTarget.value;
  const changes: Partial<ModeScheduleEntry> = field === 'mode'
    ? { mode: value as SessionMode }
    : field === 'from' ? { from: value } : { to: value };
  return (entries) => updateModeScheduleEntry(entries, index, changes);
}

export const MODE_SCHEDULE_DRAFTS_STORAGE_KEY = 'aquarium-panel-mode-schedule-drafts-v1';

export interface ModeScheduleDraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function isStoredModeScheduleEntry(value: unknown): value is ModeScheduleEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  const keys = Object.keys(entry);
  const isTimeValue = (time: unknown): time is string => typeof time === 'string'
    && (time === '' || /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time));
  return keys.length === 3
    && keys.every((key) => key === 'from' || key === 'to' || key === 'mode')
    && isTimeValue(entry.from)
    && isTimeValue(entry.to)
    && SESSION_MODE_OPTIONS.some(({ mode }) => mode === entry.mode);
}

export function readModeScheduleDrafts(
  storage: Pick<ModeScheduleDraftStorage, 'getItem'>,
): Map<string, readonly ModeScheduleEntry[]> {
  try {
    const serialized = storage.getItem(MODE_SCHEDULE_DRAFTS_STORAGE_KEY);
    if (!serialized) return new Map();
    const value: unknown = JSON.parse(serialized);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return new Map();

    const drafts: Array<[string, readonly ModeScheduleEntry[]]> = [];
    for (const [sessionId, entries] of Object.entries(value)) {
      if (sessionId.length > 0 && Array.isArray(entries) && entries.every(isStoredModeScheduleEntry)) {
        drafts.push([sessionId, entries]);
      }
    }
    return new Map(drafts);
  } catch {
    return new Map();
  }
}

export function writeModeScheduleDrafts(
  storage: ModeScheduleDraftStorage,
  drafts: ModeScheduleDrafts,
): boolean {
  try {
    if (drafts.size === 0) storage.removeItem(MODE_SCHEDULE_DRAFTS_STORAGE_KEY);
    else storage.setItem(MODE_SCHEDULE_DRAFTS_STORAGE_KEY, JSON.stringify(Object.fromEntries(drafts)));
    return true;
  } catch {
    return false;
  }
}

export function removeModeScheduleEntry(entries: readonly ModeScheduleEntry[], index: number): ModeScheduleEntry[] {
  return entries.filter((_, currentIndex) => currentIndex !== index);
}
