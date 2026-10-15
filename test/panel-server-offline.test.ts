import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import yaml from 'yaml';
import { AquariumConfigSchema } from '../src/config/schema.ts';
import type { ContactFriend, ContactGroup, ProtocolAdapter } from '../src/adapters/types.ts';
import { sessionId, type Segment, type SessionKey } from '../src/core/events.ts';
import { createPanelApp } from '../src/panel-server/app.ts';
import { openDatabase } from '../src/store/db.ts';
import { createRepository } from '../src/store/repository.ts';

const password = '[REDACTED]';
const configTemplate = AquariumConfigSchema.parse(yaml.parse(fs.readFileSync(path.resolve('config.example.yaml'), 'utf8')));
const session: SessionKey = { account: configTemplate.accounts[0]?.uin ?? 10001, kind: 'group', peer: 123456 };

class ContactAdapter implements ProtocolAdapter {
  readonly account = session.account;
  readonly nickname = '测试账号';
  readonly groups: ContactGroup[] = [{ groupId: session.peer, name: '缓存群', memberCount: 4 }];
  readonly friends: ContactFriend[] = [{ userId: 42, nickname: '好友' }];
  groupListCalls = 0;
  friendListCalls = 0;
  groupListPending: Promise<ContactGroup[]> | undefined;

  async connect(): Promise<void> {}
  close(): void {}
  onMessage(): () => void { return () => {}; }
  onStatus(): () => void { return () => {}; }
  async send(_session: SessionKey, _segments: Segment[]): Promise<{ messageId: string }> { return { messageId: '1' }; }
  async listGroups(): Promise<ContactGroup[]> {
    this.groupListCalls += 1;
    return this.groupListPending ?? this.groups;
  }
  async listFriends(): Promise<ContactFriend[]> {
    this.friendListCalls += 1;
    return this.friends;
  }
  async history(): Promise<[]> { return []; }
  async markRead(): Promise<void> {}
  async setTyping(): Promise<void> {}
  async recall(): Promise<void> {}
}

async function withPanel<T>(
  run: (value: {
    app: ReturnType<typeof createPanelApp>;
    adapter: ContactAdapter;
    setStatus: (status: 'online' | 'offline' | 'connecting') => void;
  }) => Promise<T>,
  adapterTimeoutMs?: number,
): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-panel-offline-'));
  fs.mkdirSync(path.join(root, 'panel', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'panel', 'dist', 'index.html'), '<html></html>', 'utf8');
  const database = openDatabase(path.join(root, 'panel.db'));
  const repository = createRepository(database);
  let config = AquariumConfigSchema.parse({
    ...configTemplate,
    defaults: { ...configTemplate.defaults, enabled: true },
    sessions: { ...configTemplate.sessions, [sessionId(session)]: { enabled: true } },
  });
  let status: 'online' | 'offline' | 'connecting' = 'online';
  const adapter = new ContactAdapter();
  const app = createPanelApp({
    password,
    getConfig: () => config,
    saveConfig: (next) => { config = next; },
    repository,
    accounts: () => [{ adapter, getStatus: () => status, getNickname: () => adapter.nickname }],
    management: () => [],
    root,
    ...(adapterTimeoutMs === undefined ? {} : { adapterTimeoutMs }),
  });
  try {
    return await run({ app, adapter, setStatus: (next) => { status = next; } });
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function authHeaders(): HeadersInit {
  return { Authorization: `Bearer ${password}` };
}

test('离线时 status、sessions、decisions 不调用适配器并标记 degraded', async () => {
  await withPanel(async ({ app, adapter, setStatus }) => {
    setStatus('offline');
    const [statusResponse, sessionsResponse, decisionsResponse] = await Promise.all([
      app.request('/api/status', { headers: authHeaders() }),
      app.request('/api/sessions', { headers: authHeaders() }),
      app.request('/api/decisions', { headers: authHeaders() }),
    ]);
    const status = await statusResponse.json() as { accounts: Array<{ degraded: boolean }> };
    const sessions = await sessionsResponse.json() as Array<{ sessionId: string; degraded: boolean }>;
    assert.equal(status.accounts[0]?.degraded, true);
    assert.equal(sessions.find((item) => item.sessionId === sessionId(session))?.degraded, true);
    assert.equal(decisionsResponse.status, 200);
    assert.equal(adapter.groupListCalls, 0);
    assert.equal(adapter.friendListCalls, 0);
  });
});

test('联系人读取中连接转 offline 时 status 和 sessions 都标记 degraded', async () => {
  await withPanel(async ({ app, adapter, setStatus }) => {
    let releaseGroups: ((groups: ContactGroup[]) => void) | undefined;
    adapter.groupListPending = new Promise<ContactGroup[]>((resolve) => { releaseGroups = resolve; });
    const statusRequest = app.request('/api/status', { headers: authHeaders() });
    const sessionsRequest = app.request('/api/sessions', { headers: authHeaders() });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(adapter.groupListCalls, 1);
    setStatus('offline');
    releaseGroups?.(adapter.groups);

    const [statusResponse, sessionsResponse] = await Promise.all([statusRequest, sessionsRequest]);
    const status = await statusResponse.json() as { accounts: Array<{ degraded: boolean }> };
    const sessions = await sessionsResponse.json() as Array<{ degraded: boolean }>;
    assert.equal(status.accounts[0]?.degraded, true);
    assert.equal(sessions.find((item) => item.sessionId === sessionId(session))?.degraded, true);
  });
});

test('联系人请求超时后使用缓存并快速返回 degraded 结果', async () => {
  await withPanel(async ({ app, adapter }) => {
    const initial = await app.request('/api/sessions', { headers: authHeaders() });
    assert.equal(initial.status, 200);
    adapter.groupListPending = new Promise<ContactGroup[]>(() => {});
    const response = await Promise.race([
      app.request('/api/sessions', { headers: authHeaders() }),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 250)),
    ]);
    assert.ok(response, 'panel contact request exceeded the test deadline');
    if (!response) return;
    const sessions = await response.json() as Array<{ name: string; degraded: boolean }>;
    const group = sessions.find((item) => item.name === '缓存群');
    assert.equal(group?.degraded, true);
  }, 20);
});
