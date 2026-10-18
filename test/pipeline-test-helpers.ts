import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'yaml';
import { AquariumConfigSchema } from '../src/config/schema.ts';
import { sessionId, type IncomingMessage, type Segment, type SessionKey } from '../src/core/events.ts';
import { createIdleBackoff } from '../src/core/activity/backoff.ts';
import { createActivityThreshold } from '../src/core/activity/threshold.ts';
import { createMessagePipeline } from '../src/core/pipeline.ts';
import type { ProtocolAdapter } from '../src/adapters/types.ts';
import { openDatabase } from '../src/store/db.ts';
import { createRepository } from '../src/store/repository.ts';

const exampleConfig = AquariumConfigSchema.parse(yaml.parse(
  fs.readFileSync(path.resolve('config.example.yaml'), 'utf8'),
));
export const groupSession: SessionKey = { account: 900000001, kind: 'group', peer: 123456 };
export const baseTime = new Date(2026, 9, 12, 9, 6).getTime();

export function makeConfig(options: {
  enabled?: boolean;
  nicknames?: string[];
  groupNote?: string;
  sessions?: Record<string, unknown>;
  mood?: Record<string, unknown>;
  affinity?: Record<string, unknown>;
} = {}) {
  return AquariumConfigSchema.parse({
    ...exampleConfig,
    ...(options.mood ? { mood: options.mood } : {}),
    ...(options.affinity ? { affinity: options.affinity } : {}),
    defaults: {
      ...exampleConfig.defaults,
      enabled: options.enabled ?? true,
      nicknames: options.nicknames ?? ['小鱼'],
      groupNote: options.groupNote ?? '这是游戏群。',
    },
    sessions: { ...exampleConfig.sessions, ...options.sessions },
  });
}

export function makeIncoming(options: {
  messageId?: string;
  session?: SessionKey;
  plainText?: string;
  mentionsSelf?: boolean;
  senderId?: number;
  time?: number;
} = {}): IncomingMessage {
  const plainText = options.plainText ?? '小鱼，早上好';
  return {
    session: options.session ?? groupSession,
    messageId: options.messageId ?? 'incoming-1',
    senderId: options.senderId ?? 42,
    senderName: '小明',
    segments: [{ type: 'text', text: plainText }],
    plainText,
    mentionsSelf: options.mentionsSelf ?? false,
    replyToSelf: false,
    time: options.time ?? baseTime - 60_000,
  };
}

export class FakeAdapter implements ProtocolAdapter {
  readonly account = groupSession.account;
  readonly sent: Array<{ session: SessionKey; segments: Segment[] }> = [];
  readonly calls: string[] = [];
  nickname = 'Aquarium';

  async connect(): Promise<void> {}
  close(): void {}
  onMessage(): () => void { return () => {}; }
  onStatus(): () => void { return () => {}; }
  async send(session: SessionKey, segments: Segment[]): Promise<{ messageId: string }> {
    this.calls.push('send');
    this.sent.push({ session, segments });
    return { messageId: `out-${this.sent.length}` };
  }
  async listGroups(): Promise<[]> { return []; }
  async listFriends(): Promise<[]> { return []; }
  async history(): Promise<[]> { return []; }
  async markRead(): Promise<void> { this.calls.push('markRead'); }
  async setTyping(): Promise<void> { this.calls.push('setTyping'); }
  async recall(): Promise<void> {}
}

export async function withRepository<T>(
  run: (repository: ReturnType<typeof createRepository>, personaRoot: string) => Promise<T>,
): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-pipeline-'));
  fs.mkdirSync(path.join(root, 'personas'), { recursive: true });
  fs.writeFileSync(path.join(root, 'personas', 'default.md'), '# {{name}}\n临时测试人设。', 'utf8');
  const database = openDatabase(path.join(root, 'aquarium.db'));
  try {
    return await run(createRepository(database), root);
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

export function createHarness(
  repository: ReturnType<typeof createRepository>,
  config: ReturnType<typeof makeConfig>,
  personaRoot: string,
  options: {
    replyText?: string;
    modelError?: Error;
    getConfig?: () => ReturnType<typeof makeConfig>;
  } = {},
) {
  const adapter = new FakeAdapter();
  const modelRequests: Array<{ slot: string; messages: Array<{ role: string; content: string }> }> = [];
  const waits: number[] = [];
  const pipeline = createMessagePipeline({
    getConfig: options.getConfig ?? (() => config),
    repository,
    adapter,
    getNickname: () => adapter.nickname,
    personaRoot,
    callModel: async (slot, messages) => {
      modelRequests.push({ slot, messages: messages as Array<{ role: string; content: string }> });
      if (options.modelError) throw options.modelError;
      return {
        text: options.replyText ?? '普通回复。',
        provider: 'deepseek',
        model: 'deepseek-flash',
        usage: { inputTokens: 12, cachedTokens: 0, outputTokens: 4, costCny: 0 },
      };
    },
    now: () => baseTime,
    wait: async (milliseconds) => { waits.push(milliseconds); },
    random: () => 0.4,
  });
  return { adapter, modelRequests, waits, pipeline };
}

export function createProactiveHarness(
  repository: ReturnType<typeof createRepository>,
  personaRoot: string,
  options: {
    mode?: 'natural' | 'active' | 'busy';
    proactiveCooldownSec?: number;
    talkOffset?: number;
    dailyBudget?: number;
    judgeText?: string;
    judgeError?: Error;
    replyText?: string;
    rate?: { perUserPerMinute: number; perSessionPerMinute: number; minIntervalSec: number };
    idleBackoff?: ReturnType<typeof createIdleBackoff>;
    activityThreshold?: ReturnType<typeof createActivityThreshold>;
    now?: () => number;
  } = {},
) {
  const key = sessionId(groupSession);
  const baseConfig = makeConfig({
    nicknames: [],
    sessions: {
      [key]: {
        mode: options.mode ?? 'active',
        ...(options.proactiveCooldownSec === undefined ? {} : { proactiveCooldownSec: options.proactiveCooldownSec }),
        ...(options.talkOffset === undefined ? {} : { talkOffset: options.talkOffset }),
        ...(options.rate ? { rate: options.rate } : {}),
      },
    },
  });
  const config = AquariumConfigSchema.parse({
    ...baseConfig,
    budget: {
      ...baseConfig.budget,
      ...(options.dailyBudget === undefined ? {} : { dailyCny: options.dailyBudget }),
    },
  });
  const adapter = new FakeAdapter();
  const modelSlots: string[] = [];
  const modelRequests: Array<{ slot: string; messages: Array<{ role: string; content: string }> }> = [];
  const onErrors: unknown[] = [];
  const pipeline = createMessagePipeline({
    getConfig: () => config,
    repository,
    adapter,
    getNickname: () => adapter.nickname,
    personaRoot,
    idleBackoff: options.idleBackoff,
    activityThreshold: options.activityThreshold,
    onError: (error) => { onErrors.push(error); },
    callModel: async (slot, messages) => {
      modelSlots.push(slot);
      modelRequests.push({ slot, messages: messages as Array<{ role: string; content: string }> });
      if (slot === 'judge' && options.judgeError) throw options.judgeError;
      return {
        text: slot === 'judge'
          ? options.judgeText ?? '{"probability":0.9,"reason":"question"}'
          : options.replyText ?? '可以一起看看。',
        provider: 'fake',
        model: 'fake-model',
        usage: { inputTokens: 8, cachedTokens: 0, outputTokens: 3, costCny: 0 },
      };
    },
    now: options.now ?? (() => baseTime),
    wait: async () => {},
  });
  return { adapter, config, key, modelRequests, modelSlots, onErrors, pipeline };
}
