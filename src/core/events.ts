export type ChatKind = 'group' | 'private';

/** 会话唯一标识；群聊 peer 是群号，私聊 peer 是对方 QQ 号。 */
export interface SessionKey {
  account: number;
  kind: ChatKind;
  peer: number;
}

export function sessionId(key: SessionKey): string {
  return `${key.account}:${key.kind}:${key.peer}`;
}

export type Segment =
  | { type: 'text'; text: string }
  | { type: 'at'; target: number | 'all' }
  | { type: 'image'; url: string; file?: string }
  | { type: 'reply'; messageId: string }
  | { type: 'face'; id: string }
  | { type: 'sticker'; emojiId: string }
  | { type: 'unknown'; raw: unknown };

export interface IncomingMessage {
  session: SessionKey;
  messageId: string;
  senderId: number;
  senderName: string;
  segments: Segment[];
  plainText: string;
  mentionsSelf: boolean;
  /** M1 暂不解析引用消息是否来自自己，先保留为 false。 */
  replyToSelf: boolean;
  /** Unix 毫秒时间戳。 */
  time: number;
}
