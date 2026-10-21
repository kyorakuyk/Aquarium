import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SnowLumaWebSocketClient } from '@snowluma/sdk';
import type {
  JsonObject,
  OneBotMessageEvent,
  RequestOptions,
  SnowLumaEvent,
  StatusInfo,
  SnowLumaWebSocketClientOptions,
} from '@snowluma/sdk';

export interface OneBotClient {
  readonly isConnected: boolean;
  on(event: 'open', listener: () => void): () => void;
  on(event: 'close' | 'error', listener: (...args: unknown[]) => void): () => void;
  onEvent(listener: (event: SnowLumaEvent) => void): () => void;
  onMessage(listener: (event: OneBotMessageEvent) => void): () => void;
  connect(): Promise<void>;
  getLoginInfo(): Promise<{ user_id: number; nickname: string }>;
  getStatus(options?: RequestOptions): Promise<StatusInfo>;
  close(): void;
  sendGroupMessage(groupId: number, message: unknown): Promise<{ message_id: number }>;
  sendPrivateMessage(userId: number, message: unknown): Promise<{ message_id: number }>;
  getGroupList(): Promise<JsonObject[]>;
  getFriendList(): Promise<JsonObject[]>;
  getGroupMessageHistory(params: {
    group_id: number;
    count: number;
    message_id: number;
    reverse_order: boolean;
  }): Promise<{ messages: JsonObject[] }>;
  getFriendMessageHistory(params: { user_id: number; count: number }): Promise<{ messages: JsonObject[] }>;
  markGroupMessageAsRead(messageId: number, groupId?: number): Promise<null>;
  markPrivateMessageAsRead(messageId: number, userId?: number): Promise<null>;
  raw(action: string, params?: Record<string, unknown>): Promise<unknown>;
  getImage(params: { file: string }): Promise<unknown>;
  deleteMessage(messageId: number): Promise<null>;
}

export type ClientFactory = (options: SnowLumaWebSocketClientOptions) => OneBotClient;

export const createClient: ClientFactory = (options) => (
  new SnowLumaWebSocketClient(options) as unknown as OneBotClient
);

interface WsServerConfig {
  host: string;
  port: number;
  path: string;
  accessToken?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readWsServer(snowlumaDir: string, account: number): WsServerConfig {
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

export function numericField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return undefined;
}

export function stringField(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === 'string' ? record[key] as string : undefined;
}

export function isHistoryMessage(value: unknown): value is OneBotMessageEvent {
  if (!isRecord(value) || !isRecord(value.sender)) return false;
  if (value.message_type !== 'group' && value.message_type !== 'private') return false;
  if (typeof value.time !== 'number' || !Number.isFinite(value.time)) return false;
  if (typeof value.message_id !== 'number' || !Number.isSafeInteger(value.message_id)) return false;
  if (typeof value.user_id !== 'number' || !Number.isSafeInteger(value.user_id)) return false;
  if (typeof value.sender.user_id !== 'number' || typeof value.sender.nickname !== 'string') return false;
  return value.message_type !== 'group'
    || (typeof value.group_id === 'number' && Number.isSafeInteger(value.group_id));
}

export function numericMessageId(messageId: string): number {
  const parsed = Number(messageId);
  if (!Number.isSafeInteger(parsed)) throw new Error(`无效的 OneBot message_id：${messageId}`);
  return parsed;
}
