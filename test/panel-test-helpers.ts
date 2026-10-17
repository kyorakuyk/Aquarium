import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'yaml';
import { AquariumConfigSchema } from '../src/config/schema.ts';
import { createManagementCommands } from '../src/core/management.ts';
import { createSleepWakeState } from '../src/core/sleep.ts';
import { sessionId, type IncomingMessage, type Segment, type SessionKey } from '../src/core/events.ts';
import type { ContactFriend, ContactGroup, ProtocolAdapter } from '../src/adapters/types.ts';
import { createPanelApp } from '../src/panel-server/app.ts';
import { openDatabase } from '../src/store/db.ts';
import { createRepository } from '../src/store/repository.ts';
import type { SlotCallOptions, SlotResult } from '../src/llm/slots.ts';

export const exampleConfig = AquariumConfigSchema.parse(yaml.parse(
  fs.readFileSync(path.resolve('config.example.yaml'), 'utf8'),
));
export const account = exampleConfig.accounts[0]?.uin ?? 10001;
export const groupSession: SessionKey = { account, kind: 'group', peer: 123456 };
export const testPassword = ['panel', 'test', 'only'].join('-');
export const now = new Date(2026, 9, 13, 12, 0).getTime();

export class FakeAdapter implements ProtocolAdapter {
  readonly account = account;
  readonly nickname = 'Aquarium 测试';
  readonly sent: Array<{ session: SessionKey; segments: Segment[] }> = [];
  readonly recalled: string[] = [];
  groups: ContactGroup[] = [{ groupId: groupSession.peer, name: '测试群', memberCount: 9 }];
  friends: ContactFriend[] = [{ userId: 42, nickname: '好友', remark: '好友备注' }];
  groupListFails = false;
  friendListFails = false;

  async connect(): Promise<void> {}
  close(): void {}
  onMessage(): () => void { return () => {}; }
  onStatus(): () => void { return () => {}; }
  async send(session: SessionKey, segments: Segment[]): Promise<{ messageId: string }> {
    this.sent.push({ session, segments });
    return { messageId: `out-${this.sent.length}` };
  }
  async listGroups(): Promise<ContactGroup[]> {
    if (this.groupListFails) throw new Error('group contact lookup failed');
    return this.groups;
  }
  async listFriends(): Promise<ContactFriend[]> {
    if (this.friendListFails) throw new Error('friend contact lookup failed');
    return this.friends;
  }
  async history(): Promise<[]> { return []; }
  async markRead(): Promise<void> {}
  async setTyping(): Promise<void> {}
  async recall(messageId: string): Promise<void> { this.recalled.push(messageId); }
}

export async function withPanel<T>(
  run: (options: {
    app: ReturnType<typeof createPanelApp>;
    repository: ReturnType<typeof createRepository>;
    adapter: FakeAdapter;
    modelSlots: string[];
    replayedMessages: IncomingMessage[];
    sleepWakeState: ReturnType<typeof createSleepWakeState>;
    getConfig: () => ReturnType<typeof AquariumConfigSchema.parse>;
    getSavedConfig: () => ReturnType<typeof AquariumConfigSchema.parse> | undefined;
  }) => Promise<T>,
  ownerId = exampleConfig.owner,
): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-panel-test-'));
  fs.mkdirSync(path.join(root, 'personas'), { recursive: true });
  fs.mkdirSync(path.join(root, 'panel', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'panel', 'dist', 'index.html'), '<html></html>', 'utf8');
  fs.writeFileSync(path.join(root, 'personas', 'default.md'), '# Aquarium\n默认人设。', 'utf8');
  const database = openDatabase(path.join(root, 'aquarium.db'));
  const repository = createRepository(database, () => new Date(now));
  let config = AquariumConfigSchema.parse({
    ...exampleConfig,
    owner: ownerId,
    defaults: { ...exampleConfig.defaults, enabled: true, groupNote: '全局说明' },
    sessions: {
      ...exampleConfig.sessions,
      [sessionId(groupSession)]: { enabled: true, groupNote: '本会话说明' },
    },
  });
  let savedConfig: ReturnType<typeof AquariumConfigSchema.parse> | undefined;
  const adapter = new FakeAdapter();
  const sleepWakeState = createSleepWakeState();
  const modelSlots: string[] = [];
  const replayedMessages: IncomingMessage[] = [];
  const management = createManagementCommands({
    getConfig: () => config,
    repository,
    adapter,
    now: () => now,
  });
  const app = createPanelApp({
    password: testPassword,
    getConfig: () => config,
    saveConfig: (next) => { config = next; savedConfig = next; },
    repository,
    accounts: () => [{ adapter, getStatus: () => 'online', getNickname: () => adapter.nickname }],
    sleepWakeState,
    management: () => [management],
    root,
    now: () => now,
    callModel: async (slot: string, _messages: unknown[], options: SlotCallOptions): Promise<SlotResult> => {
      modelSlots.push(slot);
      options.recordUsage({
        time: now,
        slot: 'reply',
        provider: 'deepseek',
        model: 'deepseek-flash',
        inputTokens: 10,
        cachedTokens: 0,
        outputTokens: 4,
        costCny: 0.001,
        latencyMs: 12,
        ok: true,
      });
      return {
        text: '试聊回复。',
        provider: 'deepseek',
        model: 'deepseek-flash',
        usage: { inputTokens: 10, cachedTokens: 0, outputTokens: 4, costCny: 0.001 },
      };
    },
    replayMessage: async (message: IncomingMessage) => {
      replayedMessages.push(message);
      return {
        replied: false,
        reason: 'replay',
        replay: {
          wouldReply: true,
          reason: 'replied',
          replyText: '当前配置生成的新回复。',
          trace: [{ step: 'gate', startedAt: now, durationMs: 2, summary: 'next' }],
          provider: 'fake',
          model: 'fake-model',
          replyCostCny: 0.002,
          totalCostCny: 0.005,
        },
      };
    },
  });
  try {
    return await run({
      app,
      repository,
      adapter,
      modelSlots,
      replayedMessages,
      sleepWakeState,
      getConfig: () => config,
      getSavedConfig: () => savedConfig,
    });
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

export function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${testPassword}` };
}
