import type { SessionKey } from '../shared/events.ts';

export type InteractionAction =
  | { kind: 'react'; session: SessionKey; messageId: string; emojiId: string; remove?: boolean }
  | { kind: 'poke'; session: SessionKey; targetId: number }
  | { kind: 'recall'; session: SessionKey; messageId: string; ownMessage: boolean }
  | { kind: 'mute'; session: SessionKey; targetId: number; seconds: number }
  | { kind: 'essence'; session: SessionKey; messageId: string; remove?: boolean };

export type InteractionSource = 'rule' | 'llm' | 'owner_command';
export type InteractionVerdict = 'executed' | 'dry_run' | 'blocked' | 'failed';

export interface InteractionCheckContext {
  requesterId?: number;
  sourceMessageId?: string;
}

export interface InteractionDecision {
  action: InteractionAction;
  source: InteractionSource;
  verdict: InteractionVerdict;
  reason: string;
  at: number;
}
