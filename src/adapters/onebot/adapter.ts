import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SnowLumaWebSocketClient } from '@snowluma/sdk';
import type {
  JsonObject,
  OneBotMessageEvent,
  SnowLumaWebSocketClientOptions,
} from '@snowluma/sdk';
import type { IncomingMessage, Segment, SessionKey } from '../../core/events.ts';
import type {
  AdapterStatus,
  ContactFriend,
  ContactGroup,
  ProtocolAdapter,
} from '../types.ts';
import {
  convertIncomingMessage,
  shouldDispatchMessage,
  toOneBotSegments,
} from './convert.ts';

interface OneBotClient {
  on(event: 'open', listener: () => void): () => void;
  on(event: 'close' | 'error', listener: (...args: unknown[]) => void): () => void;
  onMessage(listener: (event: OneBotMessageEvent) => void): () => void;
  connect(): Promise<void>;
  getLoginInfo(): Promise<{ user_id: number; nickname: string }>;
  close(): void;
  sendGroupMessage(groupId: number, message: unknown): Promise<{ message_id: number }>;
  sendPrivateMessage(userId: number, message: unknown): Promise<{ message_id: number }>;
  getGroupList(): Promise<JsonObject[]>;
  getFriendList(): Promise<JsonObject[]>;
  getGroupMessageHistory(params: { group_id: number; count: number }): Promise<{ messages: JsonObject[] }>;
  getFriendMessageHistory(params: { user_id: number; count: number }): Promise<{ messages: JsonObject[] }>;
  markGroupMessageAsRead(messageId: number, groupId?: number): Promise<null>;
  markPrivateMessageAsRead(messageId: number, userId?: number): Promise<null>;
  raw(action: 'set_input_status', params: { user_id: number; event_type: number }): Promise<unknown>;
  deleteMessage(messageId: number): Promise<null>;
}

type ClientFactory = (options: SnowLumaWebSocketClientOptions) => OneBotClient;

interface WsServerConfig {
  host: string;
  port: number;
  path: string;
  accessToken?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readWsServer(snowlumaDir: string, account: number): WsServerConfig {
  const configPath = join(snowlumaDir, 'config', `onebot_${account}.json`);
  const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
  if (!isRecord(parsed) || !isRecord(parsed.networks) || !Array.isArray(parsed.networks.wsServers)) {
    throw new Error(`SnowLuma 配置缺少 networks.wsServers：${configPath}`);
  }

  const server = parsed.networks.wsServers[0];
  if (!isRecord(server)
    || typeof server.host !== 'string'
    || typeof server.port !== 'number'
    || !Number.isInteger(server.port)
    || server.port < 1
    || server.port > 65535
    || (server.path !== undefined && typeof server.path !== 'string')
    || (server.accessToken !== undefined && typeof server.accessToken !== 'string')) {
    throw new Error(`SnowLuma 第一个 wsServers 配置无效：${configPath}`);
  }

  return {
    host: server.host,
    port: server.port,
    path: typeof server.path === 'string' && server.path !== '' ? server.path : '/',
    ...(typeof server.accessToken === 'string' && server.accessToken !== ''
      ? { accessToken: server.accessToken }
      : {}),
  };
}

function numericField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return undefined;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === 'string' ? record[key] as string : undefined;
}

function isHistoryMessage(value: unknown): value is OneBotMessageEvent {
  if (!isRecord(value) || !isRecord(value.sender)) return false;
  if (value.message_type !== 'group' && value.message_type !== 'private') return false;
  if (typeof value.time !== 'number' || !Number.isFinite(value.time)) return false;
  if (typeof value.message_id !== 'number' || !Number.isSafeInteger(value.message_id)) return false;
  if (typeof value.user_id !== 'number' || !Number.isSafeInteger(value.user_id)) return false;
  if (typeof value.sender.user_id !== 'number' || typeof value.sender.nickname !== 'string') return false;
  return value.message_type !== 'group'
    || (typeof value.group_id === 'number' && Number.isSafeInteger(value.group_id));
}

function numericMessageId(messageId: string): number {
  const parsed = Number(messageId);
  if (!Number.isSafeInteger(parsed)) throw new Error(`无效的 OneBot message_id：${messageId}`);
  return parsed;
}

const createClient: ClientFactory = (options) => new SnowLumaWebSocketClient(options);

export class OneBotAdapter implements ProtocolAdapter {
  readonly account: number;
  nickname = '';

  private readonly client: OneBotClient;
  private readonly messageListeners = new Set<(message: IncomingMessage) => void>();
  private readonly statusListeners = new Set<(status: AdapterStatus) => void>();
  private status: AdapterStatus = 'offline';
  private accountVerified = false;

  constructor(
    options: { account: number; snowlumaDir: string },
    clientFactory: ClientFactory = createClient,
  ) {
    this.account = options.account;
    const ws = readWsServer(options.snowlumaDir, options.account);
    this.client = clientFactory({
      url: `ws://${ws.host}:${ws.port}${ws.path}`,
      accessToken: ws.accessToken,
      reconnect: true,
    });

    this.client.on('open', () => {
      if (this.accountVerified) this.setStatus('online');
    });
    this.client.on('close', () => this.setStatus('offline'));
    this.client.on('error', () => this.setStatus('offline'));
    this.client.onMessage((event) => {
      if (!shouldDispatchMessage(event, this.account)) return;
      const incoming = convertIncomingMessage(event, this.account);
      for (const callback of this.messageListeners) callback(incoming);
    });
  }

  async connect(): Promise<void> {
    this.setStatus('connecting');
    try {
      await this.client.connect();
      const login = await this.client.getLoginInfo();
      if (login.user_id !== this.account) {
        throw new Error(`登录账号 ${login.user_id} 与配置账号 ${this.account} 不一致，拒绝工作`);
      }
      this.nickname = login.nickname;
      this.accountVerified = true;
      this.setStatus('online');
    } catch (error) {
      this.accountVerified = false;
      this.client.close();
      this.setStatus('offline');
      throw error;
    }
  }

  close(): void {
    this.accountVerified = false;
    this.client.close();
    this.setStatus('offline');
  }

  onMessage(callback: (message: IncomingMessage) => void): () => void {
    this.messageListeners.add(callback);
    return () => this.messageListeners.delete(callback);
  }

  onStatus(callback: (status: AdapterStatus) => void): () => void {
    this.statusListeners.add(callback);
    return () => this.statusListeners.delete(callback);
  }

  async send(session: SessionKey, segments: Segment[]): Promise<{ messageId: string }> {
    this.assertSessionAccount(session);
    const messageSegments = toOneBotSegments(segments);
    const result = session.kind === 'group'
      ? await this.client.sendGroupMessage(session.peer, messageSegments)
      : await this.client.sendPrivateMessage(session.peer, messageSegments);
    return { messageId: String(result.message_id) };
  }

  async listGroups(): Promise<ContactGroup[]> {
    const groups = await this.client.getGroupList();
    return groups.flatMap((group) => {
      const groupId = numericField(group, 'group_id');
      const name = stringField(group, 'group_name') ?? stringField(group, 'name');
      if (groupId === undefined || name === undefined) return [];
      const memberCount = numericField(group, 'member_count');
      return [{ groupId, name, ...(memberCount === undefined ? {} : { memberCount }) }];
    });
  }

  async listFriends(): Promise<ContactFriend[]> {
    const friends = await this.client.getFriendList();
    return friends.flatMap((friend) => {
      const userId = numericField(friend, 'user_id');
      const nickname = stringField(friend, 'nickname');
      if (userId === undefined || nickname === undefined) return [];
      const remark = stringField(friend, 'remark');
      return [{ userId, nickname, ...(remark === undefined ? {} : { remark }) }];
    });
  }

  async history(session: SessionKey, count: number): Promise<IncomingMessage[]> {
    this.assertSessionAccount(session);
    const result = session.kind === 'group'
      ? await this.client.getGroupMessageHistory({ group_id: session.peer, count })
      : await this.client.getFriendMessageHistory({ user_id: session.peer, count });

    return result.messages
      .filter(isHistoryMessage)
      .filter((event) => session.kind === 'group'
        ? event.message_type === 'group' && event.group_id === session.peer
        : event.message_type === 'private' && event.user_id === session.peer)
      .map((event) => convertIncomingMessage(event, this.account))
      .sort((left, right) => left.time - right.time);
  }

  async markRead(session: SessionKey): Promise<void> {
    const latest = await this.history(session, 1);
    const lastMessage = latest.at(-1);
    if (!lastMessage) return;

    const messageId = numericMessageId(lastMessage.messageId);
    if (session.kind === 'group') {
      await this.client.markGroupMessageAsRead(messageId, session.peer);
    } else {
      await this.client.markPrivateMessageAsRead(messageId, session.peer);
    }
  }

  async setTyping(session: SessionKey): Promise<void> {
    this.assertSessionAccount(session);
    if (session.kind === 'group') return;
    await this.client.raw('set_input_status', { user_id: session.peer, event_type: 1 });
  }

  async recall(messageId: string): Promise<void> {
    await this.client.deleteMessage(numericMessageId(messageId));
  }

  private assertSessionAccount(session: SessionKey): void {
    if (session.account !== this.account) throw new Error('SessionKey account 与适配器账号不一致');
  }

  private setStatus(status: AdapterStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const callback of this.statusListeners) callback(status);
  }
}
