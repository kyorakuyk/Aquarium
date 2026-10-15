import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import yaml from 'yaml';
import { loadConfig } from '../src/config/load.ts';
import { AquariumConfigSchema } from '../src/config/schema.ts';
import { resolveSession } from '../src/config/resolve.ts';
import { watchConfig } from '../src/config/watch.ts';
import { writeConfig } from '../src/config/write.ts';
import { sessionId, type Segment, type SessionKey } from '../src/core/events.ts';
import { createManagementCommands } from '../src/core/management.ts';
import type { ProtocolAdapter, ContactFriend, ContactGroup } from '../src/adapters/types.ts';
import { createPanelApp } from '../src/panel-server/app.ts';
import { assertLoopbackHost } from '../src/panel-server/server.ts';
import { openDatabase } from '../src/store/db.ts';
import { createRepository } from '../src/store/repository.ts';
import type { SlotCallOptions, SlotResult } from '../src/llm/slots.ts';

const exampleConfig = AquariumConfigSchema.parse(yaml.parse(
  fs.readFileSync(path.resolve('config.example.yaml'), 'utf8'),
));
const account = exampleConfig.accounts[0]?.uin ?? 10001;
const groupSession: SessionKey = { account, kind: 'group', peer: 123456 };
const testPassword = ['panel', 'test', 'only'].join('-');
const now = new Date(2026, 9, 13, 12, 0).getTime();

class FakeAdapter implements ProtocolAdapter {
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

async function withPanel<T>(
  run: (options: {
    app: ReturnType<typeof createPanelApp>;
    repository: ReturnType<typeof createRepository>;
    adapter: FakeAdapter;
    modelSlots: string[];
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
  const modelSlots: string[] = [];
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
  });
  try {
    return await run({
      app,
      repository,
      adapter,
      modelSlots,
      getConfig: () => config,
      getSavedConfig: () => savedConfig,
    });
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${testPassword}` };
}

test('本地面板只允许绑定 loopback 地址', () => {
  assert.doesNotThrow(() => assertLoopbackHost('127.0.0.1'));
  assert.doesNotThrow(() => assertLoopbackHost('::1'));
  assert.throws(() => assertLoopbackHost('0.0.0.0'), /loopback/u);
  assert.throws(() => assertLoopbackHost('192.168.1.8'), /loopback/u);
});

test('API 对无凭据和错误凭据返回 401，正确 Bearer 可访问', async () => {
  await withPanel(async ({ app }) => {
    assert.equal((await app.request('/api/status')).status, 401);
    assert.equal((await app.request('/api/status', {
      headers: { Authorization: 'Bearer wrong-key' },
    })).status, 401);
    assert.equal((await app.request('/api/status', { headers: authHeaders() })).status, 200);
    const panel = await app.request('/');
    assert.equal(panel.status, 200);
    assert.match(await panel.text(), /<html>/u);
    const oversizedBody = 'x'.repeat(2 * 1024 * 1024 + 1);
    const tooLarge = await app.request('/api/personas/import', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: oversizedBody,
    });
    assert.equal(tooLarge.status, 413);
    const tooLargeUnauthenticated = await app.request('/api/personas/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: oversizedBody,
    });
    assert.equal(tooLargeUnauthenticated.status, 413);
  });
});

test('状态、会话覆盖、决策调试和撤回 API 返回仓储事实', async () => {
  await withPanel(async ({ app, repository, adapter }) => {
    const statusResponse = await app.request('/api/status', { headers: authHeaders() });
    const status = await statusResponse.json() as {
      accounts: Array<{ account: number; connectionStatus: string }>;
      enabledSessionCount: number;
      budgetState: { state: string };
    };
    assert.equal(status.accounts[0]?.account, account);
    assert.equal(status.accounts[0]?.connectionStatus, 'online');
    assert.equal(status.enabledSessionCount, 2);
    assert.equal(status.budgetState.state, 'ok');

    const sessionsResponse = await app.request('/api/sessions', { headers: authHeaders() });
    const sessions = await sessionsResponse.json() as Array<{
      sessionId: string;
      memberCount?: number;
      overrides: string[];
      effective: { groupNote: string };
    }>;
    const group = sessions.find((session) => session.sessionId === sessionId(groupSession));
    assert.equal(group?.memberCount, 9);
    assert.ok(group?.overrides.includes('groupNote'));
    assert.equal(group?.effective.groupNote, '本会话说明');

    repository.recordDecision({
      time: now,
      sessionId: sessionId(groupSession),
      messageId: 'decision-1',
      replied: true,
      reason: 'owner_mentioned',
      detail: { promptHash: '0123456789abcdef' },
    });
    repository.recordDebugTrace({
      time: now,
      sessionId: sessionId(groupSession),
      messageId: 'decision-1',
      slot: 'reply',
      provider: 'deepseek',
      model: 'deepseek-flash',
      promptJson: '[]',
      responseText: '测试回复',
      promptHash: '0123456789abcdef',
      detail: {},
    });
    const decisionsResponse = await app.request('/api/decisions?limit=50', { headers: authHeaders() });
    const decisions = await decisionsResponse.json() as Array<{ id: number; hasDebugTrace: boolean }>;
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]?.hasDebugTrace, true);

    const traceResponse = await app.request(`/api/decisions/${decisions[0]?.id}/trace`, { headers: authHeaders() });
    const trace = await traceResponse.json() as { traces: Array<{ promptHash: string }> };
    assert.equal(trace.traces[0]?.promptHash, '0123456789abcdef');

    assert.equal((await app.request('/api/mute-all', { method: 'POST', headers: authHeaders() })).status, 200);
    const mutedStatus = await app.request('/api/status', { headers: authHeaders() });
    assert.equal((await mutedStatus.json() as { allMuted: boolean }).allMuted, true);
    assert.equal((await app.request('/api/unmute-all', { method: 'POST', headers: authHeaders() })).status, 200);
    const unmutedStatus = await app.request('/api/status', { headers: authHeaders() });
    assert.equal((await unmutedStatus.json() as { allMuted: boolean }).allMuted, false);

    repository.saveMessage({
      sessionId: sessionId(groupSession),
      messageId: 'self-message-1',
      senderId: account,
      senderName: adapter.nickname,
      isSelf: true,
      plainText: '已发送回复',
      segments: [{ type: 'text', text: '已发送回复' }],
      time: now,
    });
    const recall = await app.request('/api/recall/self-message-1', { method: 'POST', headers: authHeaders() });
    assert.equal(recall.status, 200);
    assert.deepEqual(adapter.recalled, ['self-message-1']);
  });
});

test('pipeline trace API 受保护并返回决策的步骤时间线', async () => {
  await withPanel(async ({ app, repository }) => {
    const session = sessionId(groupSession);
    const trace = [{ step: 'gate', startedAt: now, durationMs: 2.5, summary: 'disabled' }];
    repository.recordDecision({
      time: now,
      sessionId: session,
      messageId: 'pipeline-api-message',
      replied: false,
      reason: 'disabled',
      detail: {},
    });
    repository.recordPipelineTrace({
      time: now,
      sessionId: session,
      messageId: 'pipeline-api-message',
      trace,
    });

    const decisionsResponse = await app.request('/api/decisions?limit=50', { headers: authHeaders() });
    const decisions = await decisionsResponse.json() as Array<{ id: number; hasPipelineTrace: boolean }>;
    assert.equal(decisions[0]?.hasPipelineTrace, true);
    const decisionId = decisions[0]?.id;
    assert.ok(decisionId);

    assert.equal((await app.request(`/api/decisions/${decisionId}/pipeline-trace`)).status, 401);
    const response = await app.request(`/api/decisions/${decisionId}/pipeline-trace`, { headers: authHeaders() });
    assert.equal(response.status, 200);
    const body = await response.json() as { decisionId: number; trace: unknown[] };
    assert.equal(body.decisionId, decisionId);
    assert.deepEqual(body.trace, trace);
  });
});

test('决策 API 提供可读会话名、截断消息文本和可选费用', async () => {
  await withPanel(async ({ app, repository }) => {
    const longText = '鱼'.repeat(65);
    repository.saveMessage({
      sessionId: sessionId(groupSession),
      messageId: 'readable-group-message',
      senderId: 42,
      senderName: '群友',
      isSelf: false,
      plainText: longText,
      segments: [{ type: 'text', text: longText }],
      time: now,
    });
    repository.recordDecision({
      time: now,
      sessionId: sessionId(groupSession),
      messageId: 'readable-group-message',
      replied: true,
      reason: 'replied',
      detail: { costCny: 0.01234 },
    });

    repository.saveMessage({
      sessionId: sessionId(groupSession),
      messageId: 'friend-message',
      senderId: 42,
      senderName: '群友',
      isSelf: false,
      plainText: '不能跨会话匹配的同名消息',
      segments: [{ type: 'text', text: '不能跨会话匹配的同名消息' }],
      time: now,
    });
    const friendSession: SessionKey = { account, kind: 'private', peer: 42 };
    repository.recordDecision({
      time: now,
      sessionId: sessionId(friendSession),
      messageId: 'friend-message',
      replied: false,
      reason: 'not_mentioned',
      detail: { costCny: 0 },
    });
    const unknownSession: SessionKey = { account, kind: 'private', peer: 777 };
    repository.recordDecision({
      time: now,
      sessionId: sessionId(unknownSession),
      messageId: 'missing-message',
      replied: false,
      reason: 'disabled',
      detail: { costCny: 'not-a-number' },
    });

    const response = await app.request('/api/decisions?limit=50', { headers: authHeaders() });
    const decisions = await response.json() as Array<{
      messageId: string;
      sessionName: string;
      messageText: string | null;
      costCny: number | null;
    }>;
    const groupDecision = decisions.find((decision) => decision.messageId === 'readable-group-message');
    assert.equal(groupDecision?.sessionName, '测试群');
    assert.equal(groupDecision?.messageText, '鱼'.repeat(60));
    assert.equal(Array.from(groupDecision?.messageText ?? '').length, 60);
    assert.equal(groupDecision?.costCny, 0.01234);

    const friendDecision = decisions.find((decision) => decision.messageId === 'friend-message');
    assert.equal(friendDecision?.sessionName, '好友备注');
    assert.equal(friendDecision?.messageText, null);
    assert.equal(friendDecision?.costCny, 0);

    const unknownDecision = decisions.find((decision) => decision.messageId === 'missing-message');
    assert.equal(unknownDecision?.sessionName, sessionId(unknownSession));
    assert.equal(unknownDecision?.messageText, null);
    assert.equal(unknownDecision?.costCny, null);
  });
});

test('决策 API 联系人列表读取失败时回退为 sessionId', async () => {
  await withPanel(async ({ app, repository, adapter }) => {
    adapter.groupListFails = true;
    repository.recordDecision({
      time: now,
      sessionId: sessionId(groupSession),
      messageId: 'group-contact-error',
      replied: false,
      reason: 'disabled',
      detail: {},
    });

    const response = await app.request('/api/decisions', { headers: authHeaders() });
    const decisions = await response.json() as Array<{ sessionId: string; sessionName: string }>;
    assert.equal(decisions[0]?.sessionName, sessionId(groupSession));
  });
});

test('PATCH 会话字段设为 null 时删除覆盖并恢复继承', async () => {
  await withPanel(async ({ app, getConfig, getSavedConfig }) => {
    const response = await app.request(`/api/sessions/${encodeURIComponent(sessionId(groupSession))}`, {
      method: 'PATCH',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupNote: null, enabled: null }),
    });

    assert.equal(response.status, 200);
    const next = getSavedConfig();
    assert.ok(next);
    assert.equal(next.sessions[sessionId(groupSession)]?.groupNote, undefined);
    assert.equal(next.sessions[sessionId(groupSession)]?.enabled, undefined);
    assert.equal(resolveSession(getConfig(), groupSession).groupNote, '全局说明');
    assert.equal(resolveSession(getConfig(), groupSession).enabled, true);
  });
});

test('并发 PATCH 保留彼此修改的会话字段', async () => {
  await withPanel(async ({ app, getConfig }) => {
    const url = `/api/sessions/${encodeURIComponent(sessionId(groupSession))}`;
    const request = (body: unknown) => app.request(url, {
      method: 'PATCH',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const responses = await Promise.all([
      request({ groupNote: '并发补充说明' }),
      request({ nicknames: ['阿水'] }),
    ]);

    assert.deepEqual(responses.map((response) => response.status), [200, 200]);
    assert.equal(getConfig().sessions[sessionId(groupSession)]?.groupNote, '并发补充说明');
    assert.deepEqual(getConfig().sessions[sessionId(groupSession)]?.nicknames, ['阿水']);
  });
});

test('PATCH 原子写入配置并立即更新热重载中的有效值', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-panel-config-test-'));
  fs.mkdirSync(path.join(root, 'panel', 'dist'), { recursive: true });
  fs.mkdirSync(path.join(root, 'personas'), { recursive: true });
  fs.writeFileSync(path.join(root, 'panel', 'dist', 'index.html'), '<html></html>', 'utf8');
  fs.writeFileSync(path.join(root, 'personas', 'default.md'), '# Aquarium', 'utf8');
  const configPath = path.join(root, 'config.yaml');
  const examplePath = path.resolve('config.example.yaml');
  fs.copyFileSync(examplePath, configPath);
  const logger = { info: () => undefined, error: () => undefined };
  const watcher = watchConfig({ configPath, examplePath, logger });
  const database = openDatabase(path.join(root, 'aquarium.db'));
  const repository = createRepository(database, () => new Date(now));
  const adapter = new FakeAdapter();
  const management = createManagementCommands({
    getConfig: () => watcher.getConfig(),
    repository,
    adapter,
    now: () => now,
  });
  const app = createPanelApp({
    password: testPassword,
    getConfig: () => watcher.getConfig(),
    saveConfig: (next) => {
      writeConfig(next, configPath);
      watcher.replaceConfig(next);
    },
    repository,
    accounts: () => [{ adapter, getStatus: () => 'online', getNickname: () => adapter.nickname }],
    management: () => [management],
    root,
  });

  try {
    const response = await app.request(`/api/sessions/${encodeURIComponent(sessionId(groupSession))}`, {
      method: 'PATCH',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(response.status, 200);
    assert.equal(watcher.getConfig().sessions[sessionId(groupSession)]?.enabled, true);
    assert.equal(loadConfig({ configPath, examplePath, logger }).sessions[sessionId(groupSession)]?.enabled, true);
  } finally {
    watcher.close();
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sandbox 使用 reply 槽位并记录用量，但不写 messages', async () => {
  await withPanel(async ({ app, repository, modelSlots }) => {
    const messageCountBefore = repository.recentMessages(sessionId(groupSession), 10).length;
    const response = await app.request('/api/sandbox/chat', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: sessionId(groupSession),
        asOwner: true,
        history: [{ role: 'user', text: '之前说过你好' }, { role: 'bot', text: '你好呀' }],
        text: '再介绍一下',
      }),
    });

    assert.equal(response.status, 200);
    const body = await response.json() as { parts: string[]; decisionSteps: unknown[] };
    assert.deepEqual(body.parts, ['试聊回复。']);
    assert.ok(body.decisionSteps.length > 0);
    assert.deepEqual(modelSlots, ['reply']);
    assert.equal(repository.recentMessages(sessionId(groupSession), 10).length, messageCountBefore);
    assert.ok(repository.costToday() > 0);
    const usage = await app.request('/api/usage/today', { headers: authHeaders() });
    assert.equal((await usage.json() as { requestCount: number }).requestCount, 1);
  });
});

test('owner 未设置时试聊不会把扮演者伪标为主人', async () => {
  await withPanel(async ({ app }) => {
    const status = await app.request('/api/status', { headers: authHeaders() });
    assert.equal((await status.json() as { ownerConfigured: boolean }).ownerConfigured, false);

    const response = await app.request('/api/sandbox/chat', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: sessionId(groupSession),
        asOwner: true,
        history: [],
        text: '测试身份边界',
      }),
    });
    const body = await response.json() as { decisionSteps: Array<{ step: string; asOwner?: boolean }> };
    assert.equal(body.decisionSteps.find((step) => step.step === 'prompt')?.asOwner, false);
  }, 0);
});

test('人设导入校验路径 ID、写入后可读回，并拒绝冲突', async () => {
  await withPanel(async ({ app }) => {
    const invalid = await app.request('/api/personas/import', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: '../escape.md', markdown: '# 不可写' }),
    });
    assert.equal(invalid.status, 400);

    const imported = await app.request('/api/personas/import', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'new-card.md', markdown: '# 新人设\n你好。' }),
    });
    assert.equal(imported.status, 201);
    const readBack = await app.request('/api/personas/new-card', { headers: authHeaders() });
    assert.equal(readBack.status, 200);
    assert.equal((await readBack.json() as { markdown: string }).markdown, '# 新人设\n你好。');

    const conflict = await app.request('/api/personas/import', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'new-card.md', markdown: '# 覆盖' }),
    });
    assert.equal(conflict.status, 409);
  });
});
