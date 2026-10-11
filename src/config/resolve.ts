import { sessionId, type SessionKey } from '../core/events.ts';
import type { AquariumConfig, SessionOverride, SessionSettings } from './schema.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function setOwnValue(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

export function deepMerge<T>(base: T, overrides: unknown): T {
  if (Array.isArray(overrides)) return [...overrides] as T;
  if (!isRecord(overrides)) return (overrides === undefined ? base : overrides) as T;

  const baseRecord: Record<string, unknown> = isRecord(base) ? base : {};
  const result: Record<string, unknown> = { ...baseRecord };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    const mergedValue = Array.isArray(value)
      ? [...value]
      : isRecord(value)
        ? deepMerge(baseRecord[key], value)
        : value;
    setOwnValue(result, key, mergedValue);
  }
  return result as T;
}

export function resolveSession(config: AquariumConfig, key: SessionKey): SessionSettings {
  const overrides: SessionOverride = config.sessions[sessionId(key)] ?? {};
  return deepMerge(config.defaults, overrides);
}
