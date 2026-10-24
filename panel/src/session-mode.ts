import type { ModeScheduleEntry, SessionMode } from './api.ts';

export const SESSION_MODE_OPTIONS: readonly { mode: SessionMode; title: string; note: string }[] = [
  { mode: 'mention_only', title: '只在被叫时', note: '需要被叫到' },
  { mode: 'natural', title: '自然', note: '偶尔自然接话' },
  { mode: 'active', title: '积极', note: '更积极地参与' },
  { mode: 'busy', title: '忙碌', note: '回复更少、更短' },
];

export interface ModeScheduleSegment {
  startMinute: number;
  endMinute: number;
  mode: SessionMode;
}

function validMinuteOfDay(value: string): number | undefined {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) return undefined;
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

function scheduleMatchesMinute(entry: ModeScheduleEntry, minute: number): boolean {
  const from = validMinuteOfDay(entry.from);
  const to = validMinuteOfDay(entry.to);
  if (from === undefined || to === undefined || from === to) return false;
  return from < to
    ? minute >= from && minute < to
    : minute >= from || minute < to;
}

export function modeScheduleTimeline(
  entries: readonly ModeScheduleEntry[],
  defaultMode: SessionMode,
): ModeScheduleSegment[] {
  const boundaries = new Set([0, 1440]);
  for (const entry of entries) {
    const from = validMinuteOfDay(entry.from);
    const to = validMinuteOfDay(entry.to);
    if (from !== undefined) boundaries.add(from);
    if (to !== undefined) boundaries.add(to);
  }
  const minutes = [...boundaries].sort((first, second) => first - second);
  const segments: ModeScheduleSegment[] = [];
  for (let index = 0; index < minutes.length - 1; index += 1) {
    const startMinute = minutes[index]!;
    const endMinute = minutes[index + 1]!;
    const mode = entries.find((entry) => scheduleMatchesMinute(entry, startMinute))?.mode ?? defaultMode;
    const previous = segments.at(-1);
    if (previous?.mode === mode && previous.endMinute === startMinute) previous.endMinute = endMinute;
    else segments.push({ startMinute, endMinute, mode });
  }
  return segments;
}

export function modeScheduleSummary(entries: readonly ModeScheduleEntry[], defaultMode: SessionMode): string {
  const validEntries = entries.filter((entry) => validMinuteOfDay(entry.from) !== undefined
    && validMinuteOfDay(entry.to) !== undefined && entry.from !== entry.to);
  if (validEntries.length === 0) return '未设置';
  const label = (mode: SessionMode) => SESSION_MODE_OPTIONS.find((option) => option.mode === mode)?.title ?? mode;
  const timeline = modeScheduleTimeline(entries, defaultMode);
  const modes = new Set(timeline.map((segment) => segment.mode));
  if (modes.size === 1) {
    const mode = timeline[0]!.mode;
    return mode === defaultMode ? '这个时段没有效果（与默认模式相同）' : `全天${label(mode)}`;
  }
  const formatMinute = (minute: number) => {
    const hours = Math.floor(minute / 60);
    const minutes = minute % 60;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  };
  const first = timeline[0]!;
  const last = timeline.at(-1)!;
  const wrapsMidnight = timeline.length > 1
    && first.startMinute === 0
    && last.endMinute === 1440
    && first.mode === last.mode;
  const periods: { startMinute: number; text: string }[] = [];
  if (wrapsMidnight && first.mode !== defaultMode) {
    periods.push({
      startMinute: last.startMinute,
      text: `${formatMinute(last.startMinute)}–${formatMinute(first.endMinute)} ${label(first.mode)}`,
    });
  }
  for (const segment of wrapsMidnight ? timeline.slice(1, -1) : timeline) {
    if (segment.mode === defaultMode) continue;
    periods.push({
      startMinute: segment.startMinute,
      text: `${formatMinute(segment.startMinute)}–${formatMinute(segment.endMinute)} ${label(segment.mode)}`,
    });
  }
  periods.sort((firstPeriod, secondPeriod) => firstPeriod.startMinute - secondPeriod.startMinute);
  const summary = periods.map((period) => period.text);
  if (timeline.some((segment) => segment.mode === defaultMode)) summary.push(`其余时间${label(defaultMode)}`);
  return summary.join(' · ');
}

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
