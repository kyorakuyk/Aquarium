import type { SessionSettings } from '../../config/schema.ts';

export type Mode = SessionSettings['mode'];
export type ModeSchedule = NonNullable<SessionSettings['modeSchedule']>;

function minuteOfDay(value: string): number {
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

export function resolveMode(
  settings: Pick<SessionSettings, 'mode' | 'modeSchedule'>,
  now: number,
): Mode {
  const current = new Date(now);
  const currentMinute = current.getHours() * 60 + current.getMinutes();

  for (const schedule of settings.modeSchedule ?? []) {
    const from = minuteOfDay(schedule.from);
    const to = minuteOfDay(schedule.to);
    const matches = from < to
      ? currentMinute >= from && currentMinute < to
      : from > to && (currentMinute >= from || currentMinute < to);
    if (matches) return schedule.mode;
  }

  return settings.mode;
}
