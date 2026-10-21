import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import yaml from 'yaml';
import { AquariumConfigSchema } from '../src/config/schema.ts';
import { sessionId, type IncomingMessage, type SessionKey } from '../src/core/shared/events.ts';
import { createSessionQueue } from '../src/core/conversation/session-queue.ts';
import type { ProtocolAdapter, ContactFriend, ContactGroup, HistoryOptions } from '../src/adapters/types.ts';
import { openDatabase } from '../src/store/db.ts';
import { createRepository } from '../src/store/repository.ts';
import { createHistoryCatchUp } from '../src/core/conversation/history-catchup.ts';

const exampleConfig = AquariumConfigSchema.parse(yaml.parse(
  fs.readFileSync(path.resolve('config.example.yaml'), 'utf8'),
));
const account = exampleConfig.accounts[0]?.uin ?? 10001;
const groupSession: SessionKey = { account, kind: 'group', peer: 123456 };
const privateSession: SessionKey = { account, kind: 'private', peer: 42 };
const now = 1_700_000_000_000;

function makeConfig(options: {
  enabled?: boolean;
  sessions?: Record<string, unknown>;
} = {}) {
  return AquariumConfigSchema.parse({
    ...exampleConfig,
    defaults: {
      ...exampleConfig.defaults,
      enabled: options.enabled ?? false,
      nicknames: ['小鱼'],
    },
    sessions: { ...exampleConfig.sessions, ...options.sessions },
  });
}

function makeMessage(options: {
  session?: SessionKey;
  messageId: string;
  plainText: string;
  mentionsSelf?: boolean;
  senderId?: number;
  time: number;
}): IncomingMessage {
  const messageSession = options.session ?? groupSession;
  return {
    session: messageSession,
    messageId: options.messageId,
    senderId: options.senderId ?? 42,
    senderName: '群友',
    segments: [{ type: 'text', text: options.plainText }],
    plainText: options.plainText,
    mentionsSelf: options.mentionsSelf ?? false,
    replyToSelf: false,
    time: options.time,
  };
}

class FakeAdapter implements ProtocolAdapter {
  readonly account = account;
  readonly historyCalls: Array<{ session: SessionKey; count: number }> = [];
  groups: ContactGroup[] = [];
  friends: ContactFriend[] = [];
  histories = new Map<string, IncomingMessage[]>();

  async connect(): Promise<void> {}
  close(): void {}
  onMessage(): () => void { return () => {}; }
  onStatus(): () => void { return () => {}; }
  async send(): Promise<{ messageId: string }> { return { messageId: 'out' }; }
  async listGroups(): Promise<ContactGroup[]> { return this.groups; }
  async listFriends(): Promise<ContactFriend[]> { return this.friends; }
  async history(session: SessionKey, request: number | HistoryOptions): Promise<IncomingMessage[]> {
    const count = typeof request === 'number' ? request : request.count;
    this.historyCalls.push({ session, count });
    return this.histories.get(sessionId(session)) ?? [];
  }
  async markRead(): Promise<void> {}
  async setTyping(): Promise<void> {}
  async recall(): Promise<void> {}
  async getGroupInfo(): Promise<undefined> { return undefined; }
  async getGroupMembers(): Promise<undefined> { return undefined; }
  async getGroupHonors(): Promise<undefined> { return undefined; }
  async getStrangerInfo(): Promise<undefined> { return undefined; }
  async getGroupNoticeLatest(): Promise<undefined> { return undefined; }
  async getEssenceCount(): Promise<undefined> { return undefined; }
}

async function withRepository<T>(
  run: (repository: ReturnType<typeof createRepository>) => Promise<T>,
): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-history-catchup-'));
  const database = openDatabase(path.join(root, 'aquarium.db'));
  try {
    return await run(createRepository(database));
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function createHarness(
  adapter: FakeAdapter,
  repository: ReturnType<typeof createRepository>,
  config: ReturnType<typeof makeConfig>,
) {
  const queue = createSessionQueue();
  const processed: Array<{ messageId: string; sessionId: string; alreadySaved: boolean }> = [];
  const errors: unknown[] = [];
  const catchUp = createHistoryCatchUp({
    adapter,
    getConfig: () => config,
    repository,
    now: () => now,
    onError: (error) => errors.push(error),
    enqueue: (key, task) => queue.run(key, task),
    processMessage: async (message, options) => {
      processed.push({
        messageId: message.messageId,
        sessionId: sessionId(message.session),
        alreadySaved: options.alreadySaved === true,
      });
      return { replied: false, reason: 'test' };
    },
  });
  return { catchUp, processed, errors, queue };
}

test('补课保存全部新消息，每个会话只把最新触发消息排入队列', async () => {
  await withRepository(async (repository) => {
    const groupKey = sessionId(groupSession);
    const privateKey = sessionId(privateSession);
    const config = makeConfig({ sessions: { [groupKey]: { enabled: true }, [privateKey]: { enabled: true } } });
    const adapter = new FakeAdapter();
    adapter.histories.set(groupKey, [
      makeMessage({ messageId: 'group-old', plainText: '小鱼先前的问题', time: now - 8 * 60_000 }),
      makeMessage({ messageId: 'group-no-trigger', plainText: '普通闲聊', time: now - 2 * 60_000 }),
      makeMessage({ messageId: 'group-latest', plainText: '看这里', mentionsSelf: true, time: now - 60_000 }),
    ]);
    adapter.histories.set(privateKey, [
      makeMessage({ session: privateSession, messageId: 'private-self', plainText: '机器人自己的旧消息', senderId: account, time: now - 90_000 }),
      makeMessage({ session: privateSession, messageId: 'private-latest', plainText: '你好', senderId: 42, time: now - 30_000 }),
    ]);
    const harness = createHarness(adapter, repository, config);

    await harness.catchUp();

    assert.deepEqual(harness.processed, [
      { messageId: 'group-latest', sessionId: groupKey, alreadySaved: true },
      { messageId: 'private-latest', sessionId: privateKey, alreadySaved: true },
    ]);
    assert.deepEqual(adapter.historyCalls.map(({ session: key, count }) => [sessionId(key), count]), [
      [groupKey, 50],
      [privateKey, 50],
    ]);
    assert.deepEqual(repository.recentMessages(groupKey, 10).map((message) => message.messageId), [
      'group-old', 'group-no-trigger', 'group-latest',
    ]);
    assert.deepEqual(repository.recentMessages(privateKey, 10).map((message) => message.messageId), [
      'private-self', 'private-latest',
    ]);
    assert.deepEqual(harness.errors, []);
  });
});

test('最新触发消息超过十分钟时只补入库不回复', async () => {
  await withRepository(async (repository) => {
    const key = sessionId(groupSession);
    const config = makeConfig({ sessions: { [key]: { enabled: true } } });
    const adapter = new FakeAdapter();
    adapter.histories.set(key, [
      makeMessage({ messageId: 'too-old', plainText: '小鱼，看看', time: now - 10 * 60_000 - 1 }),
    ]);
    const harness = createHarness(adapter, repository, config);

    await harness.catchUp();

    assert.deepEqual(harness.processed, []);
    assert.equal(repository.recentMessages(key, 10).length, 1);
  });
});

test('补课忽略已入库消息，不重复触发回复', async () => {
  await withRepository(async (repository) => {
    const key = sessionId(groupSession);
    const message = makeMessage({ messageId: 'already-saved', plainText: '小鱼，看看', time: now - 30_000 });
    repository.saveMessage({
      sessionId: key,
      messageId: message.messageId,
      senderId: message.senderId,
      senderName: message.senderName,
      isSelf: false,
      plainText: message.plainText,
      segments: message.segments,
      time: message.time,
    });
    const config = makeConfig({ sessions: { [key]: { enabled: true } } });
    const adapter = new FakeAdapter();
    adapter.histories.set(key, [message]);
    const harness = createHarness(adapter, repository, config);

    await harness.catchUp();

    assert.deepEqual(harness.processed, []);
    assert.equal(repository.recentMessages(key, 10).length, 1);
  });
});

test('默认启用时枚举群和好友，并尊重会话级关闭覆盖', async () => {
  await withRepository(async (repository) => {
    const groupA: SessionKey = { account, kind: 'group', peer: 2001 };
    const groupB: SessionKey = { account, kind: 'group', peer: 2002 };
    const friendA: SessionKey = { account, kind: 'private', peer: 3001 };
    const friendB: SessionKey = { account, kind: 'private', peer: 3002 };
    const config = makeConfig({
      enabled: true,
      sessions: {
        [sessionId(groupB)]: { enabled: false },
        [sessionId(friendB)]: { enabled: false },
      },
    });
    const adapter = new FakeAdapter();
    adapter.groups = [{ groupId: groupA.peer, name: 'A' }, { groupId: groupB.peer, name: 'B' }];
    adapter.friends = [{ userId: friendA.peer, nickname: 'A' }, { userId: friendB.peer, nickname: 'B' }];
    const harness = createHarness(adapter, repository, config);

    await harness.catchUp();

    assert.deepEqual(adapter.historyCalls.map(({ session: key }) => sessionId(key)), [
      sessionId(groupA), sessionId(friendA),
    ]);
    assert.deepEqual(harness.errors, []);
  });
});

test('拉取离线历史期间实时会话队列不被阻塞', async () => {
  await withRepository(async (repository) => {
    const key = sessionId(groupSession);
    const config = makeConfig({ sessions: { [key]: { enabled: true } } });
    const adapter = new FakeAdapter();
    let releaseHistory!: () => void;
    let notifyHistoryStarted!: () => void;
    const historyStarted = new Promise<void>((resolve) => { notifyHistoryStarted = resolve; });
    const historyGate = new Promise<void>((resolve) => { releaseHistory = resolve; });
    adapter.history = async () => {
      notifyHistoryStarted();
      await historyGate;
      return [];
    };
    const harness = createHarness(adapter, repository, config);

    const catchUp = harness.catchUp();
    await historyStarted;
    let realTimeHandled = false;
    await harness.queue.run(key, async () => { realTimeHandled = true; });

    assert.equal(realTimeHandled, true);
    releaseHistory();
    await catchUp;
  });
});

test('离线补课逐个会话串行拉取历史', async () => {
  await withRepository(async (repository) => {
    const groupKey = sessionId(groupSession);
    const friendKey = sessionId(privateSession);
    const config = makeConfig({ sessions: { [groupKey]: { enabled: true }, [friendKey]: { enabled: true } } });
    const adapter = new FakeAdapter();
    adapter.groups = [{ groupId: groupSession.peer, name: 'A' }];
    adapter.friends = [{ userId: privateSession.peer, nickname: 'A' }];
    const calls: string[] = [];
    let active = 0;
    let maxActive = 0;
    let releaseGroupHistory!: () => void;
    let notifyGroupHistoryStarted!: () => void;
    const groupHistoryGate = new Promise<void>((resolve) => { releaseGroupHistory = resolve; });
    const groupHistoryStarted = new Promise<void>((resolve) => { notifyGroupHistoryStarted = resolve; });
    adapter.history = async (session) => {
      const key = sessionId(session);
      calls.push(key);
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        if (key === groupKey) {
          notifyGroupHistoryStarted();
          await groupHistoryGate;
        }
        return [];
      } finally {
        active -= 1;
      }
    };
    const harness = createHarness(adapter, repository, config);

    const catchUp = harness.catchUp();
    await groupHistoryStarted;
    assert.deepEqual(calls, [groupKey]);
    releaseGroupHistory();
    await catchUp;

    assert.deepEqual(calls, [groupKey, friendKey]);
    assert.equal(maxActive, 1);
  });
});

test('任一会话补课失败时返回失败，仍继续处理后续会话', async () => {
  await withRepository(async (repository) => {
    const groupKey = sessionId(groupSession);
    const friendKey = sessionId(privateSession);
    const config = makeConfig({ sessions: { [groupKey]: { enabled: true }, [friendKey]: { enabled: true } } });
    const adapter = new FakeAdapter();
    const calls: string[] = [];
    adapter.history = async (session) => {
      calls.push(sessionId(session));
      if (session.kind === 'group') throw new Error('fixture history failure');
      return [];
    };
    const harness = createHarness(adapter, repository, config);

    assert.equal(await harness.catchUp(), false);
    assert.deepEqual(calls, [groupKey, friendKey]);
    assert.equal(harness.errors.length, 1);
  });
});
