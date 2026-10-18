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
  HistoryOptions,
  ProtocolAdapter,
} from '../types.ts';
import {
  convertIncomingMessage,
  shouldDispatchMessage,
  toOneBotSegments,
} from './convert.ts';

interface OneBotClient {
  readonly isConnected: boolean;
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
  getGroupMessageHistory(params: {
    group_id: number;
    count: number;
    message_id: number;
    reverse_order: boolean;
  }): Promise<{ messages: JsonObject[] }>;
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

const INITIAL_RETRY_DELAY_MS = 2_000;
const MAX_RETRY_DELAY_MS = 30_000;
const ADAPTER_ACTION_TIMEOUT_MS = 10_000;
const QUICK_RECONNECT_WINDOW_MS = 30_000;
const QUICK_RETRY_DELAY_MS = 1_000;
const QUICK_CONNECT_TIMEOUT_MS = 3_000;

class AccountMismatchError extends Error {}

class AdapterTimeoutError extends Error {
  constructor(action: string, timeoutMs: number) {
    super(`OneBot action ${action} timed out after ${timeoutMs}ms`);
    this.name = 'AdapterTimeoutError';
  }
}

class AdapterOfflineError extends Error {
  constructor(account: number) {
    super(`OneBot adapter ${account} is not online`);
    this.name = 'AdapterOfflineError';
  }
}

interface OneBotAdapterRuntimeOptions {
  setActionTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearActionTimer?: typeof globalThis.clearTimeout;
  setRetryTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearRetryTimer?: typeof globalThis.clearTimeout;
}

const createClient: ClientFactory = (options) => new SnowLumaWebSocketClient(options);

export class OneBotAdapter implements ProtocolAdapter {
  readonly account: number;
  nickname = '';

  private client: OneBotClient;
  private readonly clientFactory: ClientFactory;
  private readonly clientOptions: SnowLumaWebSocketClientOptions;
  private clientUnsubscribers: Array<() => void> = [];
  private clientRequiresReplacement = false;
  private accountVerified = false;
  private readonly onConnectionError: ((error: unknown) => void) | undefined;
  private readonly messageListeners = new Set<(message: IncomingMessage) => void>();
  private readonly statusListeners = new Set<(status: AdapterStatus) => void>();
  private readonly setActionTimer: NonNullable<OneBotAdapterRuntimeOptions['setActionTimer']>;
  private readonly clearActionTimer: typeof globalThis.clearTimeout;
  private readonly setRetryTimer: NonNullable<OneBotAdapterRuntimeOptions['setRetryTimer']>;
  private readonly clearRetryTimer: typeof globalThis.clearTimeout;
  private status: AdapterStatus = 'offline';
  private connectionInFlight: Promise<void> | undefined;
  private retryAttemptInFlight: Promise<void> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private quickReconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private retryAttempts = 0;
  private connectionGeneration = 0;
  private retryImmediatelyRequested = false;
  private quickReconnectActive = false;
  private started = false;

  constructor(
    options: { account: number; snowlumaDir: string; onConnectionError?: (error: unknown) => void },
    clientFactory: ClientFactory = createClient,
    runtimeOptions: OneBotAdapterRuntimeOptions = {},
  ) {
    this.account = options.account;
    this.clientFactory = clientFactory;
    this.onConnectionError = options.onConnectionError;
    this.setActionTimer = runtimeOptions.setActionTimer
      ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
    this.clearActionTimer = runtimeOptions.clearActionTimer ?? globalThis.clearTimeout;
    this.setRetryTimer = runtimeOptions.setRetryTimer
      ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
    this.clearRetryTimer = runtimeOptions.clearRetryTimer ?? globalThis.clearTimeout;
    const ws = readWsServer(options.snowlumaDir, options.account);
    this.clientOptions = {
      url: `ws://${ws.host}:${ws.port}${ws.path}`,
      accessToken: ws.accessToken,
      requestTimeoutMs: ADAPTER_ACTION_TIMEOUT_MS,
      reconnect: false,
    };
    this.client = this.clientFactory(this.clientOptions);
    this.bindClient(this.client);
  }

  private bindClient(client: OneBotClient): void {
    this.clientUnsubscribers = [
      client.on('open', () => {
        if (client !== this.client) return;
        this.setStatus('connecting');
      }),
      client.on('close', () => {
        if (client !== this.client) return;
        this.accountVerified = false;
        this.connectionGeneration += 1;
        this.nickname = '';
        this.setStatus('offline');
        if (this.started && !this.retryAttemptInFlight) this.scheduleRetry();
      }),
      client.on('error', (error) => {
        if (client !== this.client) return;
        this.accountVerified = false;
        this.setStatus('offline');
        if (this.started && !this.retryAttemptInFlight) this.scheduleRetry();
        if (!this.retryAttemptInFlight) {
          try { this.onConnectionError?.(error); } catch { /* do not let logging break reconnect */ }
        }
      }),
      client.onMessage((event) => {
        if (client !== this.client || !this.accountVerified || !shouldDispatchMessage(event, this.account)) return;
        const incoming = convertIncomingMessage(event, this.account);
        for (const callback of this.messageListeners) callback(incoming);
      }),
    ];
  }

  private replaceClient(): void {
    const previous = this.client;
    this.accountVerified = false;
    const replacement = this.clientFactory(this.clientOptions);
    this.clientRequiresReplacement = false;
    if (replacement === previous) return;

    const previousUnsubscribers = this.clientUnsubscribers;
    this.client = replacement;
    this.clientUnsubscribers = [];
    this.bindClient(replacement);
    for (const unsubscribe of previousUnsubscribers) unsubscribe();
    try {
      previous.close();
    } catch (error) {
      try { this.onConnectionError?.(error); } catch { /* preserve the active client */ }
    }
  }

  async connect(): Promise<void> {
    if (this.status === 'waiting_login') throw new AdapterOfflineError(this.account);
    if (this.connectionInFlight) return this.connectionInFlight;
    const generation = this.connectionGeneration;
    const attempt = this.connectAndVerify(generation).finally(() => {
      if (this.connectionInFlight === attempt) this.connectionInFlight = undefined;
    });
    this.connectionInFlight = attempt;
    return attempt;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.connectionGeneration += 1;
    this.runRetryAttempt();
  }

  waitForLogin(): void {
    if (this.started) return;
    this.started = true;
    this.connectionGeneration += 1;
    this.clearRetry();
    this.clearQuickReconnectWindow();
    this.accountVerified = false;
    this.nickname = '';
    this.setStatus('waiting_login');
  }

  retryNow(): void {
    if (!this.started) return;
    if (this.status === 'online' && this.client.isConnected) return;
    if (this.status === 'waiting_login') this.setStatus('offline');
    if (this.status === 'online') {
      this.clientRequiresReplacement = true;
      this.accountVerified = false;
      this.nickname = '';
      this.setStatus('offline');
    }
    this.startQuickReconnectWindow();
    this.clearRetry();
    if (this.retryAttemptInFlight) {
      this.retryImmediatelyRequested = true;
      return;
    }
    this.runRetryAttempt();
  }

  private async connectAndVerify(generation: number): Promise<void> {
    this.accountVerified = false;
    if (this.clientRequiresReplacement) this.replaceClient();
    const client = this.client;
    this.setStatus('connecting');
    const connectionTimeoutMs = this.quickReconnectActive
      ? QUICK_CONNECT_TIMEOUT_MS
      : ADAPTER_ACTION_TIMEOUT_MS;
    try {
      await this.withActionTimeout('connect', () => client.connect(), false, connectionTimeoutMs);
      if (client !== this.client || generation !== this.connectionGeneration) return;
      const login = await this.withActionTimeout('get_login_info', () => client.getLoginInfo(), false, connectionTimeoutMs);
      if (client !== this.client || generation !== this.connectionGeneration) return;
      if (login.user_id !== this.account) {
        throw new AccountMismatchError(`登录账号 ${login.user_id} 与配置账号 ${this.account} 不一致，拒绝工作`);
      }
      this.accountVerified = true;
      this.nickname = login.nickname;
      this.retryAttempts = 0;
      this.clearRetry();
      this.clearQuickReconnectWindow();
      this.retryImmediatelyRequested = false;
      this.setStatus('online');
    } catch (error) {
      if (client === this.client && generation === this.connectionGeneration) {
        this.accountVerified = false;
        this.nickname = '';
        this.setStatus('offline');
        if (error instanceof AccountMismatchError) {
          this.clientRequiresReplacement = true;
          client.close();
        }
      }
      throw error;
    }
  }

  close(): void {
    this.started = false;
    this.retryImmediatelyRequested = false;
    this.connectionGeneration += 1;
    this.clearRetry();
    this.clearQuickReconnectWindow();
    this.clientRequiresReplacement = true;
    this.accountVerified = false;
    this.client.close();
    this.setStatus('offline');
  }

  private runRetryAttempt(): void {
    if (!this.started || this.retryAttemptInFlight) return;
    const attempt = this.connect()
      .catch((error: unknown) => {
        try { this.onConnectionError?.(error); } catch { /* do not let logging break reconnect */ }
      })
      .finally(() => {
        if (this.retryAttemptInFlight === attempt) this.retryAttemptInFlight = undefined;
        if (!this.started || this.status === 'online') return;
        if (this.retryImmediatelyRequested) {
          this.retryImmediatelyRequested = false;
          this.clearRetry();
          this.runRetryAttempt();
          return;
        }
        this.scheduleRetry();
      });
    this.retryAttemptInFlight = attempt;
  }

  private scheduleRetry(): void {
    if (!this.started || this.retryTimer !== undefined) return;
    const delay = this.quickReconnectActive
      ? QUICK_RETRY_DELAY_MS
      : Math.min(INITIAL_RETRY_DELAY_MS * (2 ** this.retryAttempts), MAX_RETRY_DELAY_MS);
    if (!this.quickReconnectActive) this.retryAttempts += 1;
    this.retryTimer = this.setRetryTimer(() => {
      this.retryTimer = undefined;
      this.runRetryAttempt();
    }, delay);
  }

  private startQuickReconnectWindow(): void {
    this.clearQuickReconnectWindow();
    this.quickReconnectActive = true;
    this.quickReconnectTimer = this.setRetryTimer(() => {
      this.quickReconnectTimer = undefined;
      this.quickReconnectActive = false;
      if (this.retryTimer === undefined) return;
      this.clearRetry();
      this.scheduleRetry();
    }, QUICK_RECONNECT_WINDOW_MS);
  }

  private clearQuickReconnectWindow(): void {
    this.quickReconnectActive = false;
    if (this.quickReconnectTimer === undefined) return;
    this.clearRetryTimer(this.quickReconnectTimer);
    this.quickReconnectTimer = undefined;
  }

  private clearRetry(): void {
    if (this.retryTimer === undefined) return;
    this.clearRetryTimer(this.retryTimer);
    this.retryTimer = undefined;
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
    this.assertOnline();
    const messageSegments = toOneBotSegments(segments);
    return this.withActionTimeout('send_message', async () => {
      const result = session.kind === 'group'
        ? await this.client.sendGroupMessage(session.peer, messageSegments)
        : await this.client.sendPrivateMessage(session.peer, messageSegments);
      return { messageId: String(result.message_id) };
    });
  }

  async listGroups(): Promise<ContactGroup[]> {
    this.assertOnline();
    return this.withActionTimeout('get_group_list', async () => {
      const groups = await this.client.getGroupList();
      return groups.flatMap((group) => {
        const groupId = numericField(group, 'group_id');
        const name = stringField(group, 'group_name') ?? stringField(group, 'name');
        if (groupId === undefined || name === undefined) return [];
        const memberCount = numericField(group, 'member_count');
        return [{ groupId, name, ...(memberCount === undefined ? {} : { memberCount }) }];
      });
    });
  }

  async listFriends(): Promise<ContactFriend[]> {
    this.assertOnline();
    return this.withActionTimeout('get_friend_list', async () => {
      const friends = await this.client.getFriendList();
      return friends.flatMap((friend) => {
        const userId = numericField(friend, 'user_id');
        const nickname = stringField(friend, 'nickname');
        if (userId === undefined || nickname === undefined) return [];
        const remark = stringField(friend, 'remark');
        return [{ userId, nickname, ...(remark === undefined ? {} : { remark }) }];
      });
    });
  }

  async history(session: SessionKey, request: number | HistoryOptions): Promise<IncomingMessage[]> {
    this.assertSessionAccount(session);
    this.assertOnline();
    const options = typeof request === 'number' ? { count: request } : request;
    const beforeMessageId = options.beforeMessageId === undefined
      ? undefined
      : numericMessageId(String(options.beforeMessageId));
    return this.withActionTimeout('get_message_history', () => this.loadHistory(session, options.count, beforeMessageId));
  }

  private async loadHistory(session: SessionKey, count: number, beforeMessageId?: number): Promise<IncomingMessage[]> {
    const result = session.kind === 'group'
      ? await this.client.getGroupMessageHistory({
        group_id: session.peer,
        count,
        message_id: beforeMessageId ?? 0,
        reverse_order: true,
      })
      : await this.client.getFriendMessageHistory({ user_id: session.peer, count });

    return result.messages
      .filter(isHistoryMessage)
      .filter((event) => session.kind === 'group'
        ? event.message_type === 'group' && event.group_id === session.peer
        : event.message_type === 'private' && event.user_id === session.peer)
      .filter((event) => session.kind !== 'group' || beforeMessageId === undefined || event.message_id !== beforeMessageId)
      .map((event) => convertIncomingMessage(event, this.account))
      .sort((left, right) => left.time - right.time);
  }

  async markRead(session: SessionKey): Promise<void> {
    this.assertSessionAccount(session);
    this.assertOnline();
    await this.withActionTimeout('mark_read', async () => {
      const latest = await this.loadHistory(session, 1);
      const lastMessage = latest.at(-1);
      if (!lastMessage) return;

      const messageId = numericMessageId(lastMessage.messageId);
      if (session.kind === 'group') {
        await this.client.markGroupMessageAsRead(messageId, session.peer);
      } else {
        await this.client.markPrivateMessageAsRead(messageId, session.peer);
      }
    });
  }

  async setTyping(session: SessionKey): Promise<void> {
    this.assertSessionAccount(session);
    this.assertOnline();
    if (session.kind === 'group') return;
    await this.withActionTimeout('set_input_status', () => this.client.raw('set_input_status', {
      user_id: session.peer,
      event_type: 1,
    }));
  }

  async recall(messageId: string): Promise<void> {
    this.assertOnline();
    await this.withActionTimeout('delete_message', () => this.client.deleteMessage(numericMessageId(messageId)));
  }

  private assertSessionAccount(session: SessionKey): void {
    if (session.account !== this.account) throw new Error('SessionKey account 与适配器账号不一致');
  }

  private assertOnline(): void {
    if (this.status === 'online' && !this.client.isConnected) {
      this.clientRequiresReplacement = true;
      this.accountVerified = false;
      this.nickname = '';
      this.setStatus('offline');
      this.scheduleRetry();
    }
    if (this.status !== 'online' || !this.client.isConnected) throw new AdapterOfflineError(this.account);
  }

  private async withActionTimeout<T>(
    action: string,
    run: () => Promise<T>,
    requireOnline = true,
    timeoutMs = ADAPTER_ACTION_TIMEOUT_MS,
  ): Promise<T> {
    const client = this.client;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = this.setActionTimer(
        () => reject(new AdapterTimeoutError(action, timeoutMs)),
        timeoutMs,
      );
    });
    try {
      return await Promise.race([Promise.resolve().then(() => {
        if (requireOnline) this.assertOnline();
        return run();
      }), timeout]);
    } catch (error) {
      if (error instanceof AdapterTimeoutError && client === this.client) {
        this.clientRequiresReplacement = true;
        this.accountVerified = false;
        this.nickname = '';
        this.setStatus('offline');
        try {
          // SDK reconnect is disabled; the application retry loop remains active.
          client.close();
        } catch (closeError) {
          try { this.onConnectionError?.(closeError); } catch { /* preserve the timeout */ }
        }
        this.scheduleRetry();
      }
      throw error;
    } finally {
      if (timer !== undefined) this.clearActionTimer(timer);
    }
  }

  private setStatus(status: AdapterStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const callback of this.statusListeners) callback(status);
  }
}
