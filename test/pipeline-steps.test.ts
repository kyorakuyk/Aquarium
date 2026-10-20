import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import yaml from 'yaml';
import type { ProtocolAdapter } from '../src/adapters/types.ts';
import { AquariumConfigSchema } from '../src/config/schema.ts';
import { resolveSession } from '../src/config/resolve.ts';
import { sessionId, type IncomingMessage, type SessionKey } from '../src/core/shared/events.ts';
import { replyDelayMs } from '../src/core/conversation/pacing.ts';
import { createRateLimiter } from '../src/core/shared/rate-limit.ts';
import { promptTemplateStore } from '../src/core/prompt/templates.ts';
import { contextStep } from '../src/core/conversation/steps/context.ts';
import { deliverStep } from '../src/core/conversation/steps/deliver.ts';
import { gateStep } from '../src/core/conversation/steps/gate.ts';
import { generateStep } from '../src/core/conversation/steps/generate.ts';
import { persistStep } from '../src/core/conversation/steps/persist.ts';
import { boundedTraceSummary, traceStep, type StepContext, type StepResult } from '../src/core/conversation/steps/types.ts';
import type { StoreRepository } from '../src/store/repository.ts';
import type { SlotResult } from '../src/llm/slots.ts';

const exampleConfig = AquariumConfigSchema.parse(yaml.parse(
  fs.readFileSync(path.resolve('config.example.yaml'), 'utf8'),
));
const session: SessionKey = { account: 7, kind: 'group', peer: 9 };

function makeMessage(): IncomingMessage {
  return {
    session,
    messageId: 'step-message',
    senderId: 11,
    senderName: 'Sender',
    segments: [{ type: 'text', text: 'hello' }],
    plainText: 'hello',
    mentionsSelf: false,
    replyToSelf: false,
    time: 1_800_000_000_000,
  };
}

function makeContext(
  t: TestContext,
  options: { isMuted?: (key: SessionKey) => boolean } = {},
): StepContext {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aquarium-step-'));
  fs.mkdirSync(path.join(root, 'personas'), { recursive: true });
  fs.writeFileSync(path.join(root, 'personas', 'default.md'), '# {{name}}\nTest persona.', 'utf8');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const repository = {
    saveMessage: (_record: unknown) => true,
    recordDecision: () => {},
    recentMessages: () => [],
    getCaption: () => undefined,
    setCaption: () => {},
    costToday: () => 0,
    recordUsage: () => {},
    recordDebugTrace: () => {},
  } as unknown as StoreRepository;
  const adapter = {
    markRead: async () => {},
    setTyping: async () => {},
    send: async () => ({ messageId: 'step-sent' }),
  } as unknown as ProtocolAdapter;
  const modelCall = async (): Promise<SlotResult> => ({
    text: 'generated',
    provider: 'fake',
    model: 'fake-model',
    usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 1, costCny: 0.01 },
  });
  const pipelineOptions = {
    getConfig: () => exampleConfig,
    repository,
    adapter,
    getNickname: () => 'Bot',
    personaRoot: root,
    callModel: modelCall,
    ...(options.isMuted === undefined ? {} : { isMuted: options.isMuted }),
  };
  const now = () => 1_800_000_000_000;
  return {
    message: makeMessage(),
    processOptions: {},
    currentSessionId: sessionId(session),
    options: pipelineOptions,
    now,
    wait: async () => {},
    random: () => 0.5,
    modelCall,
    rateLimiter: createRateLimiter(now),
    trace: [],
    state: { sentMessageIds: [], promptTemplates: promptTemplateStore.get(), promptFingerprints: [] },
  };
}

function traceFor(ctx: StepContext, step: string): void {
  const entry = ctx.trace.at(-1);
  assert.equal(entry?.step, step);
  assert.equal(typeof entry?.startedAt, 'number');
  assert.equal(Number.isFinite(entry?.durationMs), true);
  assert.equal(typeof entry?.summary, 'string');
}

test('persist step stores a new inbound message before continuing', async (t) => {
  const ctx = makeContext(t);
  let stored: unknown;
  ctx.options.repository.saveMessage = (record) => {
    stored = record;
    return true;
  };

  assert.deepEqual(await persistStep(ctx), { next: true });
  assert.equal((stored as { messageId?: string }).messageId, 'step-message');
  traceFor(ctx, 'persist');
});

test('trace summary is capped at 500 Unicode characters', async (t) => {
  assert.equal(Array.from(boundedTraceSummary('鱼'.repeat(600))).length, 500);
});

test('trace summary does not persist an unrecognized private reason', async (t) => {
  const ctx = makeContext(t);
  const privateMarker = 'L0_PRIVATE_CANARY';
  const result = { next: false, reason: privateMarker } as unknown as StepResult;

  await traceStep(ctx, 'gate', async () => result);

  assert.equal(ctx.trace[0]?.summary, 'stopped');
  assert.equal(JSON.stringify(ctx.trace).includes(privateMarker), false);
});

test('gate step stops muted sessions before trigger and rate checks', async (t) => {
  let rateChecks = 0;
  const ctx = makeContext(t, { isMuted: () => true });
  ctx.rateLimiter = {
    check: () => {
      rateChecks += 1;
      return { allowed: true };
    },
    clear: () => {},
  };

  assert.deepEqual(await gateStep(ctx), { next: false, reason: 'muted' });
  assert.equal(rateChecks, 0);
  traceFor(ctx, 'gate');
  assert.equal(ctx.trace.at(-1)?.summary, 'muted');
});

test('gate step accepts called messages in all four modes and stores the effective mode', async (t) => {
  for (const mode of ['mention_only', 'natural', 'active', 'busy'] as const) {
    const ctx = makeContext(t);
    const config = AquariumConfigSchema.parse({
      ...exampleConfig,
      defaults: { ...exampleConfig.defaults, enabled: true, mode },
    });
    ctx.options.getConfig = () => config;
    ctx.message.mentionsSelf = true;

    assert.deepEqual(await gateStep(ctx), { next: true });
    assert.equal(ctx.state.settings?.mode, mode);
  }
});

test('gate step uses mode_mention_only for an uncalled mention-only session', async (t) => {
  const ctx = makeContext(t);
  const config = AquariumConfigSchema.parse({
    ...exampleConfig,
    defaults: { ...exampleConfig.defaults, enabled: true, mode: 'mention_only' },
  });
  ctx.options.getConfig = () => config;

  assert.deepEqual(await gateStep(ctx), {
    next: false,
    reason: 'mode_mention_only',
    detail: { trigger: 'none' },
  });
  traceFor(ctx, 'gate');
  assert.equal(ctx.trace.at(-1)?.summary, 'mode_mention_only');
});

test('gate step applies the scheduled mode before deciding whether an uncalled message is ignored', async (t) => {
  const ctx = makeContext(t);
  const config = AquariumConfigSchema.parse({
    ...exampleConfig,
    defaults: {
      ...exampleConfig.defaults,
      enabled: true,
      mode: 'active',
      modeSchedule: [{ from: '23:00', to: '07:00', mode: 'mention_only' }],
    },
  });
  ctx.options.getConfig = () => config;
  ctx.now = () => new Date(2026, 9, 15, 23, 30).getTime();

  assert.deepEqual(await gateStep(ctx), {
    next: false,
    reason: 'mode_mention_only',
    detail: { trigger: 'none' },
  });
  assert.equal(ctx.state.settings?.mode, 'mention_only');
});

test('context step loads the persona and assembles a prompt', async (t) => {
  const ctx = makeContext(t);
  ctx.state.config = exampleConfig;
  ctx.state.settings = resolveSession(exampleConfig, session);

  assert.deepEqual(await contextStep(ctx), { next: true });
  assert.equal(ctx.state.persona?.includes('# Bot'), true);
  assert.equal(Array.isArray(ctx.state.prompt), true);
  traceFor(ctx, 'context');
});

test('context step adds the busy mode hint and leaves it out of other modes', async (t) => {
  const busy = makeContext(t);
  busy.state.config = exampleConfig;
  busy.state.settings = { ...resolveSession(exampleConfig, session), mode: 'busy' };
  assert.deepEqual(await contextStep(busy), { next: true });
  assert.ok(String(busy.state.prompt?.[0]?.content).includes('你现在有点忙，回得简短随意。'));

  const natural = makeContext(t);
  natural.state.config = exampleConfig;
  natural.state.settings = { ...resolveSession(exampleConfig, session), mode: 'natural' };
  assert.deepEqual(await contextStep(natural), { next: true });
  assert.equal(String(natural.state.prompt?.[0]?.content).includes('你现在有点忙，回得简短随意。'), false);
});

test('generate step records empty replies without continuing to delivery', async (t) => {
  const ctx = makeContext(t);
  ctx.state.settings = resolveSession(exampleConfig, session);
  ctx.state.nickname = 'Bot';
  ctx.state.callOptions = {
    config: exampleConfig,
    costToday: () => 0,
    recordUsage: () => {},
  };
  ctx.state.prompt = [{ role: 'user', content: 'prompt' }];
  ctx.modelCall = async () => ({
    text: '  ',
    provider: 'fake',
    model: 'fake-model',
    usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 0, costCny: 0 },
    params: { temperature: 0.4, maxTokens: 77, reasoning: 'high' },
  });

  assert.deepEqual(await generateStep(ctx), {
    next: false,
    reason: 'empty_reply',
    detail: { model: 'fake-model', params: { temperature: 0.4, maxTokens: 77, reasoning: 'high' } },
  });
  const generateTrace = ctx.trace.find((entry) => entry.step === 'generate');
  assert.deepEqual(generateTrace?.detail, { params: { temperature: 0.4, maxTokens: 77, reasoning: 'high' } });
});

test('deliver step sends and stores each reply part before returning replied', async (t) => {
  const ctx = makeContext(t);
  const sends: unknown[] = [];
  const saved: unknown[] = [];
  ctx.options.adapter.send = async (_key, segments) => {
    sends.push(segments);
    return { messageId: 'step-sent' };
  };
  ctx.options.repository.saveMessage = (record) => {
    saved.push(record);
    return true;
  };
  ctx.state.nickname = 'Bot';
  ctx.state.replyText = 'reply text';
  ctx.state.result = {
    text: 'reply text',
    provider: 'fake',
    model: 'fake-model',
    usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 2, costCny: 0.01 },
  };

  const result = await deliverStep(ctx);

  assert.equal(result.next, false);
  if (result.next) assert.fail('deliver must stop the pipeline');
  assert.equal(result.reason, 'replied');
  assert.equal(result.replied, true);
  assert.equal(sends.length, 1);
  assert.equal(saved.length, 1);
  assert.deepEqual(ctx.state.sentMessageIds, ['step-sent']);
  traceFor(ctx, 'deliver');
});

test('deliver step multiplies each busy-mode reply delay by 2.5', async (t) => {
  const ctx = makeContext(t);
  const waits: number[] = [];
  ctx.wait = async (milliseconds) => { waits.push(milliseconds); };
  ctx.state.settings = { ...resolveSession(exampleConfig, session), mode: 'busy' };
  ctx.state.nickname = 'Bot';
  ctx.state.replyText = 'reply text';
  ctx.state.result = {
    text: 'reply text',
    provider: 'fake',
    model: 'fake-model',
    usage: { inputTokens: 1, cachedTokens: 0, outputTokens: 2, costCny: 0.01 },
  };

  await deliverStep(ctx);

  assert.deepEqual(waits, [Math.round(replyDelayMs('reply text', ctx.random) * 2.5)]);
});
