import type {
  JsonObject,
  SnowLumaWebSocketClientOptions,
} from '@snowluma/sdk';
import { sessionId, type IncomingMessage, type Segment, type SessionKey } from '../../core/shared/events.ts';
import type {
  AdapterStatus,
  ContactFriend,
  ContactGroup,
  CustomFaceActions,
  HistoryOptions,
  ProtocolAdapter,
} from '../types.ts';
import {
  convertIncomingMessage,
  shouldDispatchMessage,
  toOneBotSegments,
} from './convert.ts';
import { createOneBotCustomFaceActions } from './custom-face-actions.ts';
import {
  createClient,
  isHistoryMessage,
  numericField,
  numericMessageId,
  readWsServer,
  stringField,
  type ClientFactory,
  type OneBotClient,
} from './client.ts';

interface TextSendRecord {
  sentAt?: number;
  messageId?: string;
  pending?: Promise<{ messageId: string }>;
}

const INITIAL_RETRY_DELAY_MS = 2_000;
const MAX_RETRY_DELAY_MS = 30_000;
const ADAPTER_ACTION_TIMEOUT_MS = 10_000;
const SEND_ACTION_TIMEOUT_MS = 60_000;
const QUICK_RECONNECT_WINDOW_MS = 30_000;
const QUICK_RETRY_DELAY_MS = 1_000;
const QUICK_CONNECT_TIMEOUT_MS = 3_000;

function timeoutForAction(action: string): number {
  return action.startsWith('send_') || action === 'add_custom_face' || action.startsWith('upload_')
    ? SEND_ACTION_TIMEOUT_MS
    : ADAPTER_ACTION_TIMEOUT_MS;
}

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
  now?: () => number;
  setActionTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearActionTimer?: typeof globalThis.clearTimeout;
  setRetryTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearRetryTimer?: typeof globalThis.clearTimeout;
}

export class OneBotAdapter implements ProtocolAdapter {
  readonly account: number;
  readonly customFaces: CustomFaceActions;
  nickname = '';

  private client: OneBotClient;
  private readonly clientFactory: ClientFactory;
  private readonly clientOptions: SnowLumaWebSocketClientOptions;
  private clientUnsubscribers: Array<() => void> = [];
  private clientRequiresReplacement = false;
  private accountVerified = false;
  private readonly onConnectionError: ((error: unknown) => void) | undefined;
  private readonly onDebug: ((message: string) => void) | undefined;
  private readonly getSendDedupeWindowMs: () => number;
  private readonly now: () => number;
  private readonly recentTextSends = new Map<string, Map<string, TextSendRecord>>();
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
    options: {
      account: number;
      snowlumaDir: string;
      onConnectionError?: (error: unknown) => void;
      onDebug?: (message: string) => void;
      getSendDedupeWindowMs?: () => number;
    },
    clientFactory: ClientFactory = createClient,
    runtimeOptions: OneBotAdapterRuntimeOptions = {},
  ) {
    this.account = options.account;
    this.clientFactory = clientFactory;
    this.onConnectionError = options.onConnectionError;
    this.onDebug = options.onDebug;
    this.getSendDedupeWindowMs = options.getSendDedupeWindowMs ?? (() => 8_000);
    this.now = runtimeOptions.now ?? Date.now;
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
      requestTimeoutMs: SEND_ACTION_TIMEOUT_MS,
      reconnect: false,
    };
    this.client = this.clientFactory(this.clientOptions);
    this.customFaces = createOneBotCustomFaceActions(
      () => this.client,
      (action, run) => this.withActionTimeout(action, run),
    );
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
    const text = segments.length > 0 && segments.every((segment) => segment.type === 'text')
      ? segments.map((segment) => segment.type === 'text' ? segment.text : '').join('')
      : '';
    const windowMs = this.getSendDedupeWindowMs();
    if (!text || windowMs <= 0) return this.sendOneBotMessage(session, messageSegments);

    const key = sessionId(session);
    const now = this.now();
    let records = this.recentTextSends.get(key);
    if (records) {
      for (const [recordedText, record] of records) {
        if (!record.pending && record.sentAt !== undefined && now - record.sentAt >= windowMs) {
          records.delete(recordedText);
        }
      }
      if (records.size === 0) {
        this.recentTextSends.delete(key);
        records = undefined;
      }
    }
    const existing = records?.get(text);
    if (existing?.pending) {
      this.logDuplicateTextSend(session);
      return existing.pending;
    }
    if (existing?.messageId !== undefined && existing.sentAt !== undefined && now - existing.sentAt < windowMs) {
      this.logDuplicateTextSend(session);
      return { messageId: existing.messageId };
    }

    if (!records) {
      records = new Map();
      this.recentTextSends.set(key, records);
    }
    const record: TextSendRecord = { sentAt: now };
    const pending = this.sendOneBotMessage(session, messageSegments).then((result) => {
      record.sentAt = this.now();
      record.messageId = result.messageId;
      record.pending = undefined;
      return result;
    }).catch((error: unknown) => {
      if (records?.get(text) === record) records.delete(text);
      if (records?.size === 0) this.recentTextSends.delete(key);
      throw error;
    });
    record.pending = pending;
    records.set(text, record);
    return pending;
  }

  private sendOneBotMessage(session: SessionKey, messageSegments: unknown[]): Promise<{ messageId: string }> {
    return this.withActionTimeout('send_message', async () => {
      const result = session.kind === 'group'
        ? await this.client.sendGroupMessage(session.peer, messageSegments)
        : await this.client.sendPrivateMessage(session.peer, messageSegments);
      return { messageId: String(result.message_id) };
    });
  }

  private logDuplicateTextSend(session: SessionKey): void {
    try {
      this.onDebug?.(`会话 ${sessionId(session)} 的重复文本发送已跳过。`);
    } catch {
      // 日志故障不应让消息发送失败。
    }
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
    timeoutMs = timeoutForAction(action),
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
