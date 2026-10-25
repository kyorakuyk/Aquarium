import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import yaml from 'yaml';
import { Hono } from 'hono';
import { AquariumConfigSchema, type AquariumConfig } from '../src/config/schema.ts';
import { sessionId, type IncomingMessage, type SessionKey } from '../src/core/shared/events.ts';
import { createSelfEditHandler } from '../src/core/self-edit/loop.ts';
import { parseSections } from '../src/persona/sections.ts';
import { registerEventRoutes } from '../src/panel-server/event-routes.ts';
import { openDatabase } from '../src/store/db.ts';
import { createRepository } from '../src/store/repository.ts';

const exampleConfig = AquariumConfigSchema.parse(yaml.parse(
  fs.readFileSync(path.resolve('config.example.yaml'), 'utf8'),
));
const ownerId = 9001;
const account = exampleConfig.accounts[0]?.uin ?? 10001;
const groupSession: SessionKey = { account, kind: 'group', peer: 123456 };
const initialPersona = '# 小鱼\n\n## 口头禅\n- 嗯\n\n## 底线\n- 不背叛主人\n';

function makeMessage(messageId: string, plainText: string, options: {
  senderId?: number;
  session?: SessionKey;
  segments?: IncomingMessage['segments'];
} = {}): IncomingMessage {
  return {
    session: options.session ?? groupSession,
    messageId,
    senderId: options.senderId ?? ownerId,
    senderName: '主人',
    segments: options.segments ?? [{ type: 'text', text: plainText }],
    plainText,
    mentionsSelf: false,
    replyToSelf: false,
    time: Date.UTC(2026, 9, 25, 12),
  };
}

async function withSelfEdit<T>(
  responses: string[],
  run: (context: {
    root: string;
    repository: ReturnType<typeof createRepository>;
    getConfig: () => AquariumConfig;
    handler: ReturnType<typeof createSelfEditHandler>;
    setNow: (value: number) => void;
    getModelCalls: () => number;
  }) => Promise<T>,
): Promise<T> {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'aquarium-self-edit-'));
  fs.mkdirSync(path.join(root, 'personas'), { recursive: true });
  fs.mkdirSync(path.join(root, 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'personas', 'self_edit_test.md'), initialPersona, 'utf8');
  fs.writeFileSync(path.join(root, 'prompts', 'self-edit.md'), 'Self-edit test instructions.', 'utf8');
  const database = openDatabase(path.join(root, 'aquarium.db'));
  let now = Date.UTC(2026, 9, 25, 12);
  let config = AquariumConfigSchema.parse({
    ...exampleConfig,
    owner: ownerId,
    accounts: [{ ...exampleConfig.accounts[0]!, persona: 'self_edit_test' }],
  });
  const repository = createRepository(database, () => new Date(now));
  let modelCalls = 0;
  const handler = createSelfEditHandler({
    getConfig: () => config,
    saveConfig: (next: AquariumConfig) => { config = next; },
    repository,
    root,
    now: () => now,
    callModel: async () => {
      modelCalls += 1;
      const response = responses.shift();
      if (response === undefined) throw new Error('No fake self-edit response remains');
      return response;
    },
    muteState: {
      getUntil: () => undefined,
      setUntil: () => undefined,
    },
  });
  try {
    return await run({
      root,
      repository,
      getConfig: () => config,
      handler,
      setNow: (value) => { now = value; },
      getModelCalls: () => modelCalls,
    });
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('主人命令只触发白名单闭环，非主人、引用和不在白名单的请求不会改动设置', async () => {
  const unsupported = JSON.stringify({
    action: 'propose',
    changes: [{ key: 'providers.default.apiKey', op: 'set', value: 'not-a-real-key' }],
    say: '我想改服务商密钥。',
  });
  await withSelfEdit([unsupported], async ({ root, handler, getModelCalls }) => {
    const ownerCommand = makeMessage('owner-set', '/aq set 把服务商密钥改掉');
    const privateOwnerCommand = makeMessage('private-owner-set', '/aq set 把口头禅加上哼', {
      session: { account, kind: 'private', peer: ownerId },
    });
    const nonOwnerCommand = makeMessage('non-owner-set', '/aq set 把口头禅加上哼', { senderId: ownerId + 1 });
    const quotedCommand = makeMessage('quoted-set', '/aq set 把口头禅加上哼', {
      segments: [{ type: 'reply', messageId: 'source' }, { type: 'text', text: '/aq set 把口头禅加上哼' }],
    });

    assert.equal(handler.shouldHandle(ownerCommand, ownerId), true);
    assert.equal(handler.shouldHandle(privateOwnerCommand, ownerId), true);
    assert.equal(handler.shouldHandle(nonOwnerCommand, ownerId), false);
    assert.equal(handler.shouldHandle(quotedCommand, ownerId), false);
    assert.equal(handler.shouldHandle(makeMessage('plain', '把口头禅加上哼'), ownerId), false);
    assert.match((await handler.handle(ownerCommand)).text, /不在可修改范围|白名单/u);
    assert.equal(getModelCalls(), 1);
    assert.equal(fs.readFileSync(path.join(root, 'personas', 'self_edit_test.md'), 'utf8'), initialPersona);
  });
});

test('确认提示保留完整精确差异，不截断后续设置项', async () => {
  const firstValue = '甲'.repeat(240);
  const secondValue = '乙'.repeat(240);
  await withSelfEdit([JSON.stringify({
    action: 'propose',
    changes: [
      { key: 'persona.身份', op: 'set', value: firstValue },
      { key: 'persona.背景', op: 'set', value: secondValue },
    ],
    say: '我想调整一下人设。',
  })], async ({ handler }) => {
    const proposal = await handler.handle(makeMessage('long-confirmation', '/aq set 调整人设'));
    assert.match(proposal.text, /精确变更/u);
    assert.ok(proposal.text.includes(firstValue));
    assert.ok(proposal.text.includes(secondValue));
  });
});

test('提问、过期、取消、确认与撤回都遵守二次确认并写入事件簿', async () => {
  const responses = [
    JSON.stringify({ action: 'ask', say: '想加哪一句口头禅？' }),
    JSON.stringify({
      action: 'propose',
      changes: [{ key: 'persona.口头禅', op: 'add', value: '哼' }],
      say: '我想把这句加进口头禅里。',
    }),
    JSON.stringify({
      action: 'propose',
      changes: [{ key: 'persona.口头禅', op: 'add', value: '哼' }],
      say: '我想把这句加进口头禅里。',
    }),
    JSON.stringify({
      action: 'propose',
      changes: [{ key: 'persona.口头禅', op: 'add', value: '呀' }],
      say: '我想再加一句口头禅。',
    }),
    JSON.stringify({
      action: 'propose',
      changes: [{ key: 'behavior.sleep.bedtime', op: 'set', value: '22:00' }],
      say: '我想把就寝时间改成十点。',
    }),
  ];
  await withSelfEdit(responses, async ({ root, repository, getConfig, handler, setNow }) => {
    const personaPath = path.join(root, 'data', 'personas', 'self_edit_test.md');
    const request = makeMessage('set-ask', '/aq set 改一下口头禅');
    const ask = await handler.handle(request);
    assert.match(ask.text, /想加哪一句/u);
    assert.equal(fs.readFileSync(path.join(root, 'personas', 'self_edit_test.md'), 'utf8'), initialPersona);

    const baseTime = Date.UTC(2026, 9, 25, 12);
    setNow(baseTime + 10 * 60_000 + 1);
    assert.equal(handler.shouldHandle(makeMessage('expired-confirm', '好'), ownerId), false);

    const proposal = await handler.handle(makeMessage('set-add', '/aq set 加上哼'));
    assert.match(proposal.text, /可以吗/u);
    assert.match(proposal.text, /口头禅.*哼/u);
    assert.equal(fs.readFileSync(path.join(root, 'personas', 'self_edit_test.md'), 'utf8'), initialPersona);
    assert.equal(repository.personaVersions('self_edit_test', 50).length, 0);

    const cancelled = await handler.handle(makeMessage('cancel', '算了'));
    assert.match(cancelled.text, /取消/u);
    assert.equal(fs.readFileSync(path.join(root, 'personas', 'self_edit_test.md'), 'utf8'), initialPersona);

    const secondProposal = await handler.handle(makeMessage('set-add-again', '/aq set 加上哼'));
    assert.match(secondProposal.text, /可以吗/u);
    const applied = await handler.handle(makeMessage('confirm-add', '嗯'));
    assert.match(applied.text, /已保存|生效/u);
    const appliedPersona = fs.readFileSync(personaPath, 'utf8');
    assert.match(appliedPersona, /- 嗯\n- 哼/u);
    assert.equal(repository.personaVersions('self_edit_test', 50).length, 2);

    const rollback = await handler.handle(makeMessage('rollback', '/aq set 撤回刚才的修改'));
    assert.match(rollback.text, /撤回/u);
    assert.equal(fs.readFileSync(path.join(root, 'personas', 'self_edit_test.md'), 'utf8'), initialPersona);
    const restored = await handler.handle(makeMessage('confirm-rollback', '确认'));
    assert.match(restored.text, /撤回|恢复/u);
    const restoredPersona = parseSections(fs.readFileSync(personaPath, 'utf8'));
    assert.deepEqual(restoredPersona.fields.口头禅, ['嗯']);
    assert.deepEqual(restoredPersona.fields.底线, ['不背叛主人']);

    const app = new Hono();
    registerEventRoutes(app, {
      getConfig: getConfig,
      repository,
      accounts: () => [{ adapter: { account } } as never],
      now: () => Date.UTC(2026, 9, 25, 12),
    });
    const response = await app.request(`/api/events?account=${account}`);
    assert.equal(response.status, 200);
    const body = await response.json() as { settingsChanges: Array<{ summary: string }> };
    assert.equal(body.settingsChanges.length, 2);
    assert.match(body.settingsChanges[0]!.summary, /撤回/u);

    const pendingCancel = await handler.handle(makeMessage('set-cancel-by-chat', '/aq set 口头禅加上呀'));
    assert.match(pendingCancel.text, /可以吗/u);
    assert.equal(handler.shouldHandle(makeMessage('ordinary-chat', '晚安，明天见'), ownerId), false);
    assert.equal((await handler.handle(makeMessage('not-confirmed', '确认'))).reason, 'self_edit_not_triggered');
    assert.deepEqual(parseSections(fs.readFileSync(personaPath, 'utf8')).fields.口头禅, ['嗯']);

    const configBefore = getConfig().sleep.bedtime;
    const configCommand = makeMessage('private-config-set', '/aq set 就寝时间设为 22:00', {
      session: { account, kind: 'private', peer: ownerId },
    });
    assert.equal(handler.shouldHandle(configCommand, ownerId), true);
    const configProposal = await handler.handle(configCommand);
    assert.match(configProposal.text, /22:00/u);
    assert.equal(getConfig().sleep.bedtime, configBefore);
    await handler.handle(makeMessage('private-config-confirm', '确认', {
      session: { account, kind: 'private', peer: ownerId },
    }));
    assert.equal(getConfig().sleep.bedtime, '22:00');
  });
});
