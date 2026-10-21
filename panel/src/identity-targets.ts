import type { ImpressionsView, QqMemberTargetView, SessionView } from './api.ts';

export function buildIdentityTargets(
  view: ImpressionsView | undefined,
  privateSessions: readonly SessionView[],
): QqMemberTargetView[] {
  const targets = new Map<number, QqMemberTargetView>();
  for (const member of view?.qqMembers ?? []) targets.set(member.userId, member);
  for (const session of privateSessions) {
    const userId = Number(session.sessionId.slice(session.sessionId.lastIndexOf(':') + 1));
    if (Number.isSafeInteger(userId) && userId > 0 && !targets.has(userId)) {
      targets.set(userId, { userId, name: session.name });
    }
  }
  return [...targets.values()].sort((left, right) => left.name.localeCompare(right.name));
}
