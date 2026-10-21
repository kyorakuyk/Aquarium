import type { IncomingMessage, Segment, SessionKey } from '../core/shared/events.ts';

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

export interface CustomFaceDetail {
  emojiId: string;
  resId: string;
  url: string;
  md5: string;
  desc: string;
}

export interface CustomFaceActions {
  fetchDetails(count: number): Promise<CustomFaceDetail[]>;
  addCustomFace(file: string): Promise<{ emojiId: string }>;
  modifyCustomFace(emojiId: string, desc: string): Promise<void>;
  getImageUrl(file: string): Promise<string>;
  sendCustomFace(input: {
    session: SessionKey;
    emojiId: string;
  }): Promise<{ messageId: string }>;
}

export type QqSex = 'male' | 'female' | 'unknown';
export type QqGroupRole = 'owner' | 'admin' | 'member';
export type QqGroupHonorKind = 'dragon_king' | 'performer' | 'legend' | 'emotion' | 'strong_newbie';

export interface QqGroupInfo {
  groupName?: string;
  memberCount?: number;
  maxMemberCount?: number;
  groupCreateTime?: number;
  groupLevel?: number;
  groupDescription?: string;
}

export interface QqGroupMember {
  userId: number;
  nickname?: string;
  card?: string;
  role?: QqGroupRole;
  title?: string;
  joinTime?: number;
  lastSentTime?: number;
  level?: string;
  sex?: QqSex;
  age?: number;
  isRobot?: boolean;
}

export interface QqGroupHonorHolder {
  kind: QqGroupHonorKind;
  userId?: number;
  nickname?: string;
}

export interface QqStrangerInfo {
  longNick?: string;
  qage?: number;
  regTime?: number;
}

export interface QqProfileActions {
  getGroupInfo(groupId: number): Promise<QqGroupInfo | undefined>;
  getGroupMembers(groupId: number): Promise<QqGroupMember[] | undefined>;
  getGroupHonors(groupId: number): Promise<QqGroupHonorHolder[] | undefined>;
  getStrangerInfo(userId: number): Promise<QqStrangerInfo | undefined>;
  getGroupNoticeLatest(groupId: number): Promise<string | undefined>;
  getEssenceCount(groupId: number): Promise<number | undefined>;
}

export interface ProtocolAdapter extends QqProfileActions {
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
