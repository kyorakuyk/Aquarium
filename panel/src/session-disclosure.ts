export type SessionDisclosureSection = 'schedule' | 'rhythm' | 'note';

export interface SessionDisclosureStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function sessionDisclosureKey(sessionId: string): string {
  return `aquarium-session-disclosures-v1:${sessionId}`;
}

export function readSessionDisclosure(
  storage: Pick<SessionDisclosureStorage, 'getItem'>,
  sessionId: string,
  section: SessionDisclosureSection,
): boolean {
  try {
    const serialized = storage.getItem(sessionDisclosureKey(sessionId));
    if (!serialized) return false;
    const value: unknown = JSON.parse(serialized);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    return (value as Record<string, unknown>)[section] === true;
  } catch {
    return false;
  }
}

export function writeSessionDisclosure(
  storage: SessionDisclosureStorage,
  sessionId: string,
  section: SessionDisclosureSection,
  open: boolean,
): boolean {
  try {
    const serialized = storage.getItem(sessionDisclosureKey(sessionId));
    const value: unknown = serialized ? JSON.parse(serialized) : {};
    const current = typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
    const next = Object.fromEntries(
      (['schedule', 'rhythm', 'note'] as const).flatMap((key) => {
        const state = key === section ? open : current[key];
        return typeof state === 'boolean' ? [[key, state]] : [];
      }),
    );
    storage.setItem(sessionDisclosureKey(sessionId), JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}
