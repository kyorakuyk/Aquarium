import type { IncomingMessage, Segment, SessionKey } from '../core/events.ts';

export interface ContactGroup {
  groupId: number;
  name: string;
  memberCount?: number;
}

export interface ContactFriend {
  userId: number;
  nickname: string;
  remark?: string;
}

export type AdapterStatus = 'connecting' | 'online' | 'offline' | 'waiting_login';

export interface HistoryOptions {
  count: number;
  beforeMessageId?: string | number;
}

export interface ProtocolAdapter {
  readonly account: number;
  connect(): Promise<void>;
  close(): void;
  onMessage(callback: (message: IncomingMessage) => void): () => void;
  onStatus(callback: (status: AdapterStatus) => void): () => void;
  send(session: SessionKey, segments: Segment[]): Promise<{ messageId: string }>;
  listGroups(): Promise<ContactGroup[]>;
  listFriends(): Promise<ContactFriend[]>;
  history(session: SessionKey, request: number | HistoryOptions): Promise<IncomingMessage[]>;
  markRead(session: SessionKey): Promise<void>;
  setTyping(session: SessionKey): Promise<void>;
  recall(messageId: string): Promise<void>;
}
