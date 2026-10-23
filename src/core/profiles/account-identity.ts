import type { MessageStorageRecord, StoreRepository } from '../../store/repository.ts';
import type { AccountKind } from '../../store/identity-repo.ts';
import { parseSessionId } from '../conversation/sessions.ts';

export interface AccountIdentity {
  userId: number;
  name: string;
  kind: AccountKind | undefined;
}

export function linkedAccountUserIds(
  repository: Pick<StoreRepository, 'mainUserIdFor' | 'listRelationsForUser'>,
  account: number,
  userId: number,
): number[] {
  const mainUserId = repository.mainUserIdFor(account, userId);
  const aliases = repository.listRelationsForUser(account, mainUserId)
    .filter((relation) => relation.type === 'alt')
    .flatMap((relation) => [relation.aUserId, relation.bUserId])
    .filter((candidate) => candidate !== mainUserId
      && repository.mainUserIdFor(account, candidate) === mainUserId);
  return [...new Set([mainUserId, ...aliases])];
}

function cachedGroupName(repository: StoreRepository, account: number, sessionId: string, userId: number): string | undefined {
  const key = parseSessionId(sessionId);
  if (!key || key.kind !== 'group') return undefined;
  const cached = repository.getQqMemberProfile(account, key.peer, userId);
  if (!cached) return undefined;
  try {
    const value: unknown = JSON.parse(cached.json);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    const profile = value as Record<string, unknown>;
    const card = profile.card;
    if (typeof card === 'string' && card.trim()) return card.trim();
    const nickname = profile.nickname;
    return typeof nickname === 'string' && nickname.trim() ? nickname.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function accountUserName(repository: StoreRepository, account: number, sessionId: string, userId: number): string {
  const current = repository.senderNameFor(sessionId, userId)?.trim();
  if (current && current !== String(userId)) return current;
  const latest = repository.latestSenderNameForAccount(account, userId)?.trim();
  if (latest && latest !== String(userId)) return latest;
  return cachedGroupName(repository, account, sessionId, userId)
    ?? current
    ?? latest
    ?? String(userId);
}

export function resolveAccountIdentity(
  repository: StoreRepository,
  input: { account: number; sessionId: string; userId: number; fallbackName: string },
): AccountIdentity {
  const userId = repository.mainUserIdFor(input.account, input.userId);
  const currentName = input.fallbackName.trim();
  const name = userId === input.userId && currentName && currentName !== String(userId)
    ? currentName
    : accountUserName(repository, input.account, input.sessionId, userId);
  const kind = repository.getAccountKind(input.account, userId)?.kind
    ?? repository.getAccountKind(input.account, input.userId)?.kind;
  return { userId, name, kind };
}

export function mapMessageToMainIdentity(
  repository: StoreRepository,
  account: number,
  message: MessageStorageRecord,
): MessageStorageRecord {
  const identity = resolveAccountIdentity(repository, {
    account,
    sessionId: message.sessionId,
    userId: message.senderId,
    fallbackName: message.senderName,
  });
  return { ...message, senderId: identity.userId, senderName: identity.name };
}
