import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'yaml';
import { AquariumConfigSchema } from '../src/config/schema.ts';
import { createManagementCommands } from '../src/core/conversation/management.ts';
import { createSleepWakeState } from '../src/core/sleep/index.ts';
import { sessionId, type IncomingMessage, type Segment, type SessionKey } from '../src/core/shared/events.ts';
import type { ContactFriend, ContactGroup, HistoryOptions, ProtocolAdapter } from '../src/adapters/types.ts';
import { createHistoryImportService } from '../src/core/impressions/history-import.ts';
import { createImpressionsService } from '../src/core/impressions/service.ts';
import type { ExtractTagsPromptTemplate } from '../src/core/prompt/templates.ts';
import { createPanelApp, type PanelServerOptions } from '../src/panel-server/app.ts';
import { openDatabase } from '../src/store/db.ts';
import { createInteractionLogRepository } from '../src/store/interaction-log-repo.ts';
import { createRepository } from '../src/store/repository.ts';
import { createTagSubjectRepository } from '../src/store/tag-subject-repo.ts';
import { createMemberSummaryRepository } from '../src/store/member-summary-repo.ts';
import type { SlotCallOptions, SlotResult } from '../src/llm/slots.ts';
import type { CliRuntime } from '../src/llm/cli.ts';

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
  status: 'connecting' | 'online' | 'offline' | 'waiting_login' = 'online';
  historyPages: IncomingMessage[][] = [];
  historyCalls: Array<{ session: SessionKey; request: number | HistoryOptions }> = [];
  historyError = false;
  historyGate?: Promise<IncomingMessage[]>;
  connectionHint: string | undefined;

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
  async history(session: SessionKey, request: number | HistoryOptions): Promise<IncomingMessage[]> {
    this.historyCalls.push({ session, request });
    if (this.historyError) throw new Error('history unavailable');
    if (this.historyGate) {
      const gate = this.historyGate;
      this.historyGate = undefined;
      return gate;
    }
    return this.historyPages.shift() ?? [];
  }
  async markRead(): Promise<void> {}
  async setTyping(): Promise<void> {}
  async recall(messageId: string): Promise<void> { this.recalled.push(messageId); }
  async getGroupInfo(): Promise<undefined> { return undefined; }
  async getGroupMembers(): Promise<undefined> { return undefined; }
  async getGroupHonors(): Promise<undefined> { return undefined; }
  async getStrangerInfo(): Promise<undefined> { return undefined; }
  async getGroupNoticeLatest(): Promise<undefined> { return undefined; }
  async getEssenceCount(): Promise<undefined> { return undefined; }
}

export async function withPanel<T>(
  run: (options: {
    app: ReturnType<typeof createPanelApp>;
    root: string;
    database: ReturnType<typeof openDatabase>;
    repository: ReturnType<typeof createRepository>;
    memberSummaryRepository: ReturnType<typeof createMemberSummaryRepository>;
    adapter: FakeAdapter;
    historyImports: ReturnType<typeof createHistoryImportService>;
    impressionsService: ReturnType<typeof createImpressionsService>;
    modelSlots: string[];
    replayedMessages: IncomingMessage[];
    sleepWakeState: ReturnType<typeof createSleepWakeState>;
    getConfig: () => ReturnType<typeof AquariumConfigSchema.parse>;
    getSavedConfig: () => ReturnType<typeof AquariumConfigSchema.parse> | undefined;
  }) => Promise<T>,
  ownerId = exampleConfig.owner,
  panelOptions: {
    envPath?: string;
    env?: NodeJS.ProcessEnv;
    fetch?: PanelServerOptions['fetch'];
    testProvider?: (provider: string, model: string, config: ReturnType<typeof AquariumConfigSchema.parse>) => Promise<{ ok: boolean; latencyMs: number; error?: string }>;
    cliRuntime?: CliRuntime;
    callModel?: PanelServerOptions['callModel'];
    getEnergySource?: PanelServerOptions['getEnergySource'];
    stickerServices?: PanelServerOptions['stickerServices'];
    tagClassificationService?: PanelServerOptions['tagClassificationService'];
    onError?: PanelServerOptions['onError'];
  } = {},
): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-panel-test-'));
  fs.mkdirSync(path.join(root, 'personas'), { recursive: true });
  fs.mkdirSync(path.join(root, 'panel', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'panel', 'dist', 'index.html'), '<html></html>', 'utf8');
  fs.writeFileSync(path.join(root, 'personas', 'default.md'), '# Aquarium\n默认人设。', 'utf8');
  const database = openDatabase(path.join(root, 'aquarium.db'));
  const repository = createRepository(database, () => new Date(now));
  const interactionLogRepository = createInteractionLogRepository(database);
  const tagSubjects = createTagSubjectRepository(database);
  const memberSummaryRepository = createMemberSummaryRepository(database);
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
  const impressionsService = createImpressionsService({
    repository,
    getConfig: () => config,
    callModel: async () => ({
      text: '{"group":{"observe":[],"new":[],"contradict":[]},"members":[]}',
      provider: 'fake',
      model: 'fake-model',
      usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0 },
    }),
  });
  const extractTemplate: ExtractTagsPromptTemplate = {
    source: 'fixture',
    version: 'fixture-v1',
    system: '提取群聊印象。',
    user: '上下文：{{context}}\n现有：{{existing}}',
  };
  const historyImports = createHistoryImportService({
    repository,
    getConfig: () => config,
    impressionsService,
    getTemplate: () => extractTemplate,
    now: () => now,
    wait: async () => {},
  });
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
    interactionLogRepository,
    tagSubjects,
    memberSummaryRepository,
    accounts: () => [{
      adapter,
      getStatus: () => adapter.status,
      getNickname: () => adapter.nickname,
      getConnectionHint: () => adapter.connectionHint,
    }],
    historyImports,
    impressionsService,
    sleepWakeState,
    management: () => [management],
    root,
    now: () => now,
    ...(panelOptions.envPath ? { envPath: panelOptions.envPath } : {}),
    ...(panelOptions.env ? { env: panelOptions.env } : {}),
    ...(panelOptions.fetch ? { fetch: panelOptions.fetch } : {}),
    ...(panelOptions.getEnergySource ? { getEnergySource: panelOptions.getEnergySource } : {}),
    ...(panelOptions.testProvider ? { testProvider: panelOptions.testProvider } : {}),
    ...(panelOptions.cliRuntime ? { cliRuntime: panelOptions.cliRuntime } : {}),
    ...(panelOptions.stickerServices ? { stickerServices: panelOptions.stickerServices } : {}),
    ...(panelOptions.tagClassificationService
      ? { tagClassificationService: panelOptions.tagClassificationService }
      : {}),
    ...(panelOptions.onError ? { onError: panelOptions.onError } : {}),
    callModel: panelOptions.callModel ?? (async (slot: string, _messages: unknown[], options: SlotCallOptions): Promise<SlotResult> => {
      modelSlots.push(slot);
      options.recordUsage({
        time: now,
        account: options.account,
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
    }),
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
      root,
      database,
      repository,
      memberSummaryRepository,
      adapter,
      historyImports,
      impressionsService,
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
