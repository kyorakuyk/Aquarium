import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import yaml from 'yaml';
import { AquariumConfigSchema } from '../src/config/schema.ts';
import { sessionId, type IncomingMessage, type Segment, type SessionKey } from '../src/core/events.ts';
import { createMessagePipeline } from '../src/core/pipeline.ts';
import { createManagementCommands } from '../src/core/management.ts';
import type { ProtocolAdapter, ContactFriend, ContactGroup } from '../src/adapters/types.ts';
import { openDatabase } from '../src/store/db.ts';
import { createRepository } from '../src/store/repository.ts';

const exampleConfig = AquariumConfigSchema.parse(yaml.parse(
  fs.readFileSync(path.resolve('config.example.yaml'), 'utf8'),
));
const account = exampleConfig.accounts[0]?.uin ?? 10001;
const ownerId = 9001;
const groupSession: SessionKey = { account, kind: 'group', peer: 123456 };
const ownerPrivateSession: SessionKey = { account, kind: 'private', peer: ownerId };
let currentTime = new Date(2026, 9, 13, 12, 0).getTime();

function makeConfig(options: {
  owner?: number;
  enabled?: boolean;
  sessions?: Record<string, unknown>;
  budget?: { dailyCny: number; warnRatio: number };
} = {}) {
  return AquariumConfigSchema.parse({
    ...exampleConfig,
    owner: options.owner ?? ownerId,
    defaults: {
      ...exampleConfig.defaults,
      enabled: options.enabled ?? true,
      nicknames: ['小鱼'],
    },
    sessions: { ...exampleConfig.sessions, ...options.sessions },
    budget: { ...exampleConfig.budget, ...options.budget },
  });
}

function makeMessage(options: {
  messageId: string;
  plainText: string;
  session?: SessionKey;
  senderId?: number;
  mentionsSelf?: boolean;
  time?: number;
}): IncomingMessage {
  return {
    session: options.session ?? groupSession,
    messageId: options.messageId,
    senderId: options.senderId ?? ownerId,
    senderName: '发言者',
    segments: [{ type: 'text', text: options.plainText }],
    plainText: options.plainText,
    mentionsSelf: options.mentionsSelf ?? false,
    replyToSelf: false,
    time: options.time ?? currentTime,
  };
}

class FakeAdapter implements ProtocolAdapter {
  readonly account = account;
  readonly sent: Array<{ session: SessionKey; segments: Segment[] }> = [];
  readonly recalled: string[] = [];
  groups: ContactGroup[] = [];
  friends: ContactFriend[] = [];
  nickname = 'Aquarium';

  async connect(): Promise<void> {}
  close(): void {}
  onMessage(): () => void { return () => {}; }
  onStatus(): () => void { return () => {}; }
  async send(session: SessionKey, segments: Segment[]): Promise<{ messageId: string }> {
    this.sent.push({ session, segments });
    return { messageId: `out-${this.sent.length}` };
  }
  async listGroups(): Promise<ContactGroup[]> { return this.groups; }
  async listFriends(): Promise<ContactFriend[]> { return this.friends; }
  async history(): Promise<[]> { return []; }
  async markRead(): Promise<void> {}
  async setTyping(): Promise<void> {}
  async recall(messageId: string): Promise<void> { this.recalled.push(messageId); }
}

async function withRepository<T>(
  run: (repository: ReturnType<typeof createRepository>, personaRoot: string) => Promise<T>,
): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-management-'));
  fs.mkdirSync(path.join(root, 'personas'), { recursive: true });
  fs.writeFileSync(path.join(root, 'personas', 'default.md'), '# {{name}}\n临时测试人设。', 'utf8');
  const database = openDatabase(path.join(root, 'aquarium.db'));
  try {
    return await run(createRepository(database, () => new Date(currentTime)), root);
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function createPipeline(
  repository: ReturnType<typeof createRepository>,
  personaRoot: string,
  config: ReturnType<typeof makeConfig>,
  adapter: FakeAdapter,
  options: { isMuted?: (session: SessionKey) => boolean; modelCalls?: string[] } = {},
) {
  return createMessagePipeline({
    getConfig: () => config,
    repository,
    adapter,
    getNickname: () => adapter.nickname,
    personaRoot,
    isMuted: options.isMuted,
    now: () => currentTime,
    wait: async () => {},
    random: () => 0.4,
    callModel: async (slot) => {
      options.modelCalls?.push(slot);
      return {
        text: '普通回复。',
        provider: 'deepseek',
        model: 'deepseek-flash',
        usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 3, costCny: 0 },
      };
    },
  });
}

function createCommands(
  repository: ReturnType<typeof createRepository>,
  config: ReturnType<typeof makeConfig>,
  adapter: FakeAdapter,
  onError: (error: unknown, message: IncomingMessage) => void = () => {},
) {
  return createManagementCommands({
    getConfig: () => config,
    repository,
    adapter,
    now: () => currentTime,
    onError,
  });
}

test('主人 /aq ping 直接回复；非主人命令不被拦截', async () => {
  await withRepository(async (repository, personaRoot) => {
    const config = makeConfig();
    const adapter = new FakeAdapter();
    const commands = createCommands(repository, config, adapter);
    const ownerCommand = makeMessage({ messageId: 'owner-ping', plainText: '/aq ping' });

    assert.equal(await commands.handle(ownerCommand), true);
    assert.deepEqual(adapter.sent[0]?.segments, [{ type: 'text', text: 'pong 🐟' }]);
    assert.equal(repository.recentDecisions(1)[0]?.reason, 'command_ping');

    const modelCalls: string[] = [];
    const pipeline = createPipeline(repository, personaRoot, config, adapter, { modelCalls });
    const otherCommand = makeMessage({
      messageId: 'other-ping',
      plainText: '/aq ping',
      senderId: ownerId + 1,
    });
    assert.equal(await commands.handle(otherCommand), false);
    assert.deepEqual(await pipeline(otherCommand), { replied: false, reason: 'not_mentioned' });
    assert.equal(modelCalls.length, 0);
    assert.equal(adapter.sent.length, 1);
  });
});

test('闭嘴期间被 @ 的消息记录 muted；到期后自动恢复回复', async () => {
  await withRepository(async (repository, personaRoot) => {
    currentTime = new Date(2026, 9, 13, 12, 0).getTime();
    const config = makeConfig();
    const adapter = new FakeAdapter();
    const commands = createCommands(repository, config, adapter);

    assert.equal(await commands.handle(makeMessage({ messageId: 'mute', plainText: '/aq mute 2' })), true);
    assert.deepEqual(adapter.sent[0]?.segments, [{ type: 'text', text: '好，我先不说话了（2 分钟）' }]);
    assert.equal(commands.isMuted(groupSession), true);

    const modelCalls: string[] = [];
    const pipeline = createPipeline(repository, personaRoot, config, adapter, {
      isMuted: commands.isMuted,
      modelCalls,
    });
    const mutedMessage = makeMessage({
      messageId: 'muted-mention',
      plainText: '小鱼，看看',
      senderId: 42,
      mentionsSelf: true,
      time: currentTime,
    });
    assert.deepEqual(await pipeline(mutedMessage), { replied: false, reason: 'muted' });
    assert.equal(modelCalls.length, 0);
    assert.equal(repository.recentDecisions(1)[0]?.reason, 'muted');

    currentTime += 2 * 60_000 + 1;
    const resumedMessage = makeMessage({
      messageId: 'resumed-mention',
      plainText: '小鱼，再看看',
      senderId: 42,
      mentionsSelf: true,
      time: currentTime,
    });
    assert.deepEqual(await pipeline(resumedMessage), { replied: true, reason: 'replied' });
    assert.equal(modelCalls.length, 1);
    assert.equal(commands.isMuted(groupSession), false);
  });
});

test('/aq unmute 解除本会话闭嘴', async () => {
  await withRepository(async (repository) => {
    currentTime = new Date(2026, 9, 13, 12, 0).getTime();
    const config = makeConfig();
    const adapter = new FakeAdapter();
    const commands = createCommands(repository, config, adapter);

    await commands.handle(makeMessage({ messageId: 'mute-first', plainText: '/aq mute' }));
    assert.deepEqual(adapter.sent[0]?.segments, [{ type: 'text', text: '好，我先不说话了（60 分钟）' }]);
    assert.equal(commands.isMuted(groupSession), true);
    assert.equal(await commands.handle(makeMessage({ messageId: 'unmute', plainText: '/aq unmute' })), true);

    assert.equal(commands.isMuted(groupSession), false);
    assert.deepEqual(adapter.sent[1]?.segments, [{ type: 'text', text: '我回来了' }]);
  });
});

test('/aq recall 撤回最近的 bot 消息；没有目标时返回说明', async () => {
  await withRepository(async (repository) => {
    const config = makeConfig();
    const adapter = new FakeAdapter();
    const commands = createCommands(repository, config, adapter);
    repository.saveMessage({
      sessionId: sessionId(groupSession),
      messageId: 'bot-last',
      senderId: account,
      senderName: 'Aquarium',
      isSelf: true,
      plainText: '上一条 bot 回复',
      segments: [{ type: 'text', text: '上一条 bot 回复' }],
      time: currentTime - 1,
    });

    assert.equal(await commands.handle(makeMessage({ messageId: 'recall', plainText: '/aq recall' })), true);
    assert.deepEqual(adapter.recalled, ['bot-last']);
    assert.equal(adapter.sent.length, 0);

    const emptySession: SessionKey = { account, kind: 'group', peer: 654321 };
    const emptyResult = await commands.handle(makeMessage({
      messageId: 'recall-empty',
      plainText: '/aq recall',
      session: emptySession,
    }));
    assert.equal(emptyResult, true);
    assert.deepEqual(adapter.sent[0]?.segments, [{ type: 'text', text: '没有可以撤回的消息' }]);
  });
});

test('/aq status 显示今日花费、预算状态和已启用会话数', async () => {
  await withRepository(async (repository) => {
    currentTime = new Date(2026, 9, 13, 12, 0).getTime();
    const groupA: SessionKey = { account, kind: 'group', peer: 2001 };
    const groupB: SessionKey = { account, kind: 'group', peer: 2002 };
    const friend: SessionKey = { account, kind: 'private', peer: 3001 };
    const config = makeConfig({
      enabled: true,
      sessions: { [sessionId(groupB)]: { enabled: false } },
    });
    const adapter = new FakeAdapter();
    adapter.groups = [{ groupId: groupA.peer, name: 'A' }, { groupId: groupB.peer, name: 'B' }];
    adapter.friends = [{ userId: friend.peer, nickname: '好友' }];
    repository.recordUsage({
      time: currentTime,
      slot: 'reply',
      provider: 'deepseek',
      model: 'deepseek-flash',
      inputTokens: 10,
      cachedTokens: 0,
      outputTokens: 2,
      costCny: 4,
      latencyMs: 10,
      ok: true,
    });
    const commands = createCommands(repository, config, adapter);

    await commands.handle(makeMessage({ messageId: 'status', plainText: '/aq status' }));

    const response = String(adapter.sent[0]?.segments[0]?.type === 'text'
      ? adapter.sent[0].segments[0].text
      : '');
    assert.match(response, /今日花费/);
    assert.match(response, /4\.0000/);
    assert.match(response, /提醒/);
    assert.match(response, /已启用会话 2 个/);
    assert.equal(response.includes('\n'), false);
  });
});

test('全局闭嘴状态供控制台复用', async () => {
  await withRepository(async (repository) => {
    const commands = createCommands(repository, makeConfig(), new FakeAdapter());
    assert.equal(commands.isMuted(groupSession), false);
    commands.muteAll();
    assert.equal(commands.isMuted(groupSession), true);
    assert.equal(commands.isMuted(ownerPrivateSession), true);
    commands.unmuteAll();
    assert.equal(commands.isMuted(groupSession), false);
  });
});

test('命令只在已启用会话或主人的私聊生效，owner 为零时禁用', async () => {
  await withRepository(async (repository) => {
    const config = makeConfig({ enabled: false });
    const adapter = new FakeAdapter();
    const commands = createCommands(repository, config, adapter);
    const privateCommand = makeMessage({
      messageId: 'owner-private-ping',
      session: ownerPrivateSession,
      plainText: '/aq ping',
    });
    assert.equal(await commands.handle(privateCommand), true);
    assert.deepEqual(adapter.sent[0]?.segments, [{ type: 'text', text: 'pong 🐟' }]);

    const groupCommand = makeMessage({ messageId: 'disabled-group-ping', plainText: '/aq ping' });
    assert.equal(await commands.handle(groupCommand), true);
    assert.equal(adapter.sent.length, 1);
    assert.equal(repository.recentDecisions(1)[0]?.reason, 'command_ignored');

    const noOwnerCommands = createCommands(repository, makeConfig({ owner: 0 }), adapter);
    assert.equal(await noOwnerCommands.handle(makeMessage({ messageId: 'owner-zero', plainText: '/aq ping' })), false);
  });
});
