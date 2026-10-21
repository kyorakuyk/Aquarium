import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const account = 900000001;

export function createFixture(t: { after(callback: () => void): void }, wsServers: unknown[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-onebot-adapter-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configDirectory = path.join(root, 'config');
  fs.mkdirSync(configDirectory, { recursive: true });
  fs.writeFileSync(path.join(configDirectory, `onebot_${account}.json`), JSON.stringify({
    networks: { wsServers },
  }), 'utf8');
  return root;
}

export function createTimerQueue() {
  let nextId = 1;
  const pending = new Map<number, { callback: () => void; delay: number }>();
  return {
    pending,
    set(callback: () => void, delay: number): ReturnType<typeof setTimeout> {
      const id = nextId++;
      pending.set(id, { callback, delay });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clear(timer: ReturnType<typeof setTimeout>): void {
      pending.delete(timer as unknown as number);
    },
    runNext(): number | undefined {
      const next = pending.entries().next();
      if (next.done) return undefined;
      const [id, timer] = next.value;
      pending.delete(id);
      timer.callback();
      return timer.delay;
    },
  };
}

export function groupEvent(userId: number, messageId: number, time: number) {
  return {
    time,
    self_id: account,
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: messageId,
    group_id: 123456,
    user_id: userId,
    message: [{ type: 'text', data: { text: 'hello' } }],
    raw_message: 'hello',
    font: 0,
    sender: { user_id: userId, nickname: `user-${userId}` },
  };
}

export function createFakeClient(loginUserId = account, failedConnections = 0, hangFirstConnection = false, hangLoginInfo = false) {
  const eventListeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const messageListeners = new Set<(event: unknown) => void>();
  const state = {
    loginUserId,
    connectCalls: 0,
    closeCalls: 0,
    connected: false,
    hangNextConnection: false,
    pendingConnection: undefined as Promise<void> | undefined,
    disconnectBeforeGroupSend: false,
    hangGroupSend: false,
    hangGroupHistory: false,
    getStatusCalls: 0,
    getStatusTimeouts: [] as number[],
    failStatus: false,
    hangStatus: false,
    sentGroup: [] as unknown[],
    sentPrivate: [] as unknown[],
    markedGroup: [] as unknown[],
    markedPrivate: [] as unknown[],
    rawCalls: [] as unknown[],
    rawResults: new Map<string, unknown>(),
    imageCalls: [] as unknown[],
    imageInfo: { url: 'https://gchat.qpic.cn/image.png' } as unknown,
    recalled: [] as unknown[],
    groupHistory: [] as unknown[],
    groupHistoryCalls: [] as Array<{ group_id: number; count: number; message_id: number; reverse_order: boolean }>,
    friendHistory: [] as unknown[],
  };

  const emit = (event: string, ...args: unknown[]) => {
    for (const listener of eventListeners.get(event) ?? []) listener(...args);
  };

  return {
    state,
    emitClose() {
      state.connected = false;
      emit('close');
    },
    client: {
      on(event: string, listener: (...args: unknown[]) => void) {
        const listeners = eventListeners.get(event) ?? new Set();
        listeners.add(listener);
        eventListeners.set(event, listeners);
        return () => listeners.delete(listener);
      },
      onMessage(listener: (event: unknown) => void) {
        messageListeners.add(listener);
        return () => messageListeners.delete(listener);
      },
      async connect() {
        state.connectCalls += 1;
        if (state.connected) return;
        if (state.pendingConnection) return state.pendingConnection;
        if (state.connectCalls <= failedConnections) throw new Error('fixture connection failure');
        if ((hangFirstConnection && state.connectCalls === 1) || state.hangNextConnection) {
          state.hangNextConnection = false;
          state.pendingConnection = new Promise<void>(() => {});
          return state.pendingConnection;
        }
        state.connected = true;
        emit('open');
      },
      get isConnected() { return state.connected; },
      async getLoginInfo() {
        if (hangLoginInfo) return new Promise<never>(() => {});
        return { user_id: state.loginUserId, nickname: 'Aquarium' };
      },
      async getStatus(options?: { timeoutMs?: number }) {
        state.getStatusCalls += 1;
        if (options?.timeoutMs !== undefined) state.getStatusTimeouts.push(options.timeoutMs);
        if (state.hangStatus) return new Promise<never>(() => {});
        if (state.failStatus) throw new Error('fixture status probe failure');
        return { online: true, good: true, time: 1 };
      },
      close() {
        state.closeCalls += 1;
        state.connected = false;
        state.pendingConnection = undefined;
        emit('close');
      },
      emitMessage(event: unknown) {
        for (const listener of messageListeners) listener(event);
      },
      async sendGroupMessage(...args: unknown[]) {
        if (state.hangGroupSend) return new Promise<never>(() => {});
        if (state.disconnectBeforeGroupSend) {
          state.disconnectBeforeGroupSend = false;
          state.connected = false;
          state.hangNextConnection = true;
        }
        if (!state.connected) await this.connect();
        state.sentGroup.push(args);
        return { message_id: 501 };
      },
      async sendPrivateMessage(...args: unknown[]) {
        state.sentPrivate.push(args);
        return { message_id: 502 };
      },
      async getGroupList() {
        return [{ group_id: 123456, group_name: '测试群', member_count: 8 }];
      },
      async getFriendList() {
        return [{ user_id: 42, nickname: '朋友', remark: '老友' }];
      },
      async getGroupMessageHistory(params: { group_id: number; count: number; message_id: number; reverse_order: boolean }) {
        state.groupHistoryCalls.push(params);
        if (state.hangGroupHistory) return new Promise<never>(() => {});
        return { messages: state.groupHistory };
      },
      async getFriendMessageHistory() {
        return { messages: state.friendHistory };
      },
      async markGroupMessageAsRead(...args: unknown[]) {
        state.markedGroup.push(args);
      },
      async markPrivateMessageAsRead(...args: unknown[]) {
        state.markedPrivate.push(args);
      },
      async getImage(params: { file: string }) {
        state.imageCalls.push(params);
        return state.imageInfo;
      },
      async raw(...args: unknown[]) {
        state.rawCalls.push(args);
        return state.rawResults.get(String(args[0]));
      },
      async deleteMessage(...args: unknown[]) {
        state.recalled.push(args);
      },
    },
  };
}
