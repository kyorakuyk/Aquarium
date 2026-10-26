export interface SleepPlan {
  asleep: boolean;
  cycleKey: string;
  wakeAt: number | null;
  bedAt: number | null;
}

const WAKE_WINDOW_MS = 30 * 60_000;
const SLEEP_ENERGY_DROP = 0.8;
const SLEEP_ENERGY_SHAPE = 2;

export interface SleepWakeState {
  isAwake(now: number): boolean;
  activeUntil(now: number): number | null;
  activate(now: number): void;
}

export function createSleepWakeState(): SleepWakeState {
  let awakeUntil = 0;
  return {
    isAwake: (now) => now < awakeUntil,
    activeUntil: (now) => now < awakeUntil ? awakeUntil : null,
    activate: (now) => { awakeUntil = now + WAKE_WINDOW_MS; },
  };
}

interface LocalTime {
  hour: number;
  minute: number;
  totalMinutes: number;
}

const LOCAL_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function parseLocalTime(value: string): LocalTime | undefined {
  if (!LOCAL_TIME_PATTERN.test(value)) return undefined;
  const [hourText, minuteText] = value.split(':');
  const hour = Number(hourText);
  const minute = Number(minuteText);
  return { hour, minute, totalMinutes: hour * 60 + minute };
}

function localDateKey(timestamp: number): string {
  const date = new Date(timestamp);
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function atLocalTime(timestamp: number, time: LocalTime): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  date.setHours(time.hour, time.minute, 0, 0);
  return date.getTime();
}

function shiftLocalDay(timestamp: number, days: number): number {
  const date = new Date(timestamp);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

export function sleepPlan(now: number, bedtime: string, wake: string): SleepPlan {
  const todayKey = localDateKey(now);
  const bedTime = parseLocalTime(bedtime);
  const wakeTime = parseLocalTime(wake);
  if (!bedTime || !wakeTime || bedTime.totalMinutes === wakeTime.totalMinutes) {
    return { asleep: false, cycleKey: todayKey, wakeAt: null, bedAt: null };
  }

  const current = new Date(now);
  const currentMinutes = current.getHours() * 60 + current.getMinutes();
  const crossesMidnight = bedTime.totalMinutes > wakeTime.totalMinutes;
  const asleep = crossesMidnight
    ? currentMinutes >= bedTime.totalMinutes || currentMinutes < wakeTime.totalMinutes
    : currentMinutes >= bedTime.totalMinutes && currentMinutes < wakeTime.totalMinutes;
  const todayBedAt = atLocalTime(now, bedTime);
  const todayWakeAt = atLocalTime(now, wakeTime);

  let bedAt: number;
  let wakeAt: number;
  if (asleep) {
    if (crossesMidnight && currentMinutes < wakeTime.totalMinutes) {
      bedAt = shiftLocalDay(todayBedAt, -1);
      wakeAt = todayWakeAt;
    } else {
      bedAt = todayBedAt;
      wakeAt = crossesMidnight ? shiftLocalDay(todayWakeAt, 1) : todayWakeAt;
    }
  } else if (crossesMidnight) {
    wakeAt = todayWakeAt;
    bedAt = todayBedAt;
  } else if (currentMinutes < bedTime.totalMinutes) {
    wakeAt = shiftLocalDay(todayWakeAt, -1);
    bedAt = todayBedAt;
  } else {
    wakeAt = todayWakeAt;
    bedAt = shiftLocalDay(todayBedAt, 1);
  }

  return { asleep, cycleKey: localDateKey(bedAt), wakeAt, bedAt };
}

export function sleepEnergy(
  now: number,
  wakeAt: number | null,
  bedAt: number | null,
  repliesLastHour: number,
  enabled: boolean,
): number {
  if (!enabled || wakeAt === null || bedAt === null || bedAt <= wakeAt) return 1;
  const awakeWindow = bedAt - wakeAt;
  const elapsedRatio = Math.max(0, Math.min(1, (now - wakeAt) / awakeWindow));
  const replyPenalty = Math.max(0, repliesLastHour) * 0.01;
  return Math.max(0, Math.min(1, 1 - SLEEP_ENERGY_DROP * elapsedRatio ** SLEEP_ENERGY_SHAPE - replyPenalty));
}
