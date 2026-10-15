import type { ContactFriend, ContactGroup, ProtocolAdapter } from '../adapters/types.ts';
import { resolveSession } from '../config/resolve.ts';
import type { AquariumConfig } from '../config/schema.ts';
import { sessionId, type SessionKey } from './events.ts';

export function parseSessionId(value: string): SessionKey | undefined {
  const parts = value.split(':');
  if (parts.length !== 3) return undefined;
  const account = Number(parts[0]);
  const kind = parts[1];
  const peer = Number(parts[2]);
  if (!Number.isSafeInteger(account) || account <= 0 || !Number.isSafeInteger(peer) || peer <= 0) {
    return undefined;
  }
  if (kind !== 'group' && kind !== 'private') return undefined;
  const key: SessionKey = { account, kind, peer };
  return sessionId(key) === value ? key : undefined;
}

export async function listEnabledSessions(
  adapter: ProtocolAdapter,
  config: AquariumConfig,
  onError?: (error: unknown) => void,
  contacts?: { groups: ContactGroup[]; friends: ContactFriend[] },
): Promise<SessionKey[]> {
  const candidates = new Map<string, SessionKey>();
  const add = (key: SessionKey): void => {
    if (key.account === adapter.account) candidates.set(sessionId(key), key);
  };

  if (config.defaults.enabled) {
    try {
      for (const group of contacts?.groups ?? await adapter.listGroups()) {
        add({ account: adapter.account, kind: 'group', peer: group.groupId });
      }
    } catch (error) {
      onError?.(error);
    }
    try {
      for (const friend of contacts?.friends ?? await adapter.listFriends()) {
        add({ account: adapter.account, kind: 'private', peer: friend.userId });
      }
    } catch (error) {
      onError?.(error);
    }
  }

  for (const [keyText, settings] of Object.entries(config.sessions)) {
    if (settings.enabled !== true) continue;
    const key = parseSessionId(keyText);
    if (key) add(key);
  }

  return [...candidates.values()].filter((key) => resolveSession(config, key).enabled);
}
