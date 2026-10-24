import type { SessionView } from './api.ts';

export type SessionDisplayTarget = Pick<SessionView, 'sessionId' | 'kind' | 'memberCount'>;
export type SessionOptionTarget = SessionDisplayTarget & Pick<SessionView, 'name'>;

export function sessionPeerLabel(session: SessionDisplayTarget): string {
  const parts = session.sessionId.split(':');
  const peer = parts.length === 3 && parts[1] === session.kind && parts[2]
    ? parts[2]
    : session.sessionId;
  const memberCount = session.kind === 'group' && session.memberCount !== undefined
    ? ` · ${session.memberCount} 人`
    : '';
  return `${peer}${memberCount}`;
}

export function sessionOptionLabel(session: SessionOptionTarget): string {
  return `${session.name} · ${sessionPeerLabel(session)}`;
}
