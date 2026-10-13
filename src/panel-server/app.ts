import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { serveStatic } from '@hono/node-server/serve-static';
import { z } from 'zod';
import type { AdapterStatus, ProtocolAdapter } from '../adapters/types.ts';
import type { AquariumConfig } from '../config/schema.ts';
import { AquariumConfigSchema } from '../config/schema.ts';
import { resolveSession } from '../config/resolve.ts';
import { parseSessionId, listEnabledSessions } from '../core/sessions.ts';
import { sessionId, type SessionKey } from '../core/events.ts';
import { buildPromptMessages } from '../core/prompt.ts';
import { cleanReply } from '../core/text.ts';
import { splitReply } from '../core/split.ts';
import type { PipelineModelCall } from '../core/pipeline.ts';
import { loadPersona } from '../persona/load.ts';
import type { ManagementCommands } from '../core/management.ts';
import type { StoreRepository } from '../store/repository.ts';
import { callSlot } from '../llm/slots.ts';
import { registerPersonaRoutes } from './personas.ts';
import { budgetState } from '../llm/budget.ts';

export interface PanelAccountRuntime {
  adapter: ProtocolAdapter;
  getStatus: () => AdapterStatus;
  getNickname: () => string;
}

export interface PanelServerOptions {
  password: string;
  getConfig: () => AquariumConfig;
  saveConfig: (config: AquariumConfig) => void | Promise<void>;
  repository: StoreRepository;
  accounts: () => PanelAccountRuntime[];
  management: () => ManagementCommands[];
  root?: string;
  panelDist?: string;
  now?: () => number;
  callModel?: PipelineModelCall;
  onError?: (error: unknown) => void;
}

const ratePatchSchema = z.object({
  perUserPerMinute: z.number().int().positive().nullable().optional(),
  perSessionPerMinute: z.number().int().positive().nullable().optional(),
  minIntervalSec: z.number().positive().nullable().optional(),
}).strict();

const sessionPatchSchema = z.object({
  enabled: z.boolean().nullable().optional(),
  mode: z.enum(['mention_only', 'active', 'natural', 'busy']).nullable().optional(),
  nicknames: z.array(z.string()).nullable().optional(),
  contextMessages: z.number().int().positive().nullable().optional(),
  rate: ratePatchSchema.nullable().optional(),
  groupNote: z.string().nullable().optional(),
}).strict();

const sandboxSchema = z.object({
  sessionId: z.string(),
  asOwner: z.boolean(),
  history: z.array(z.object({
    role: z.enum(['user', 'bot']),
    text: z.string().max(5_000),
  }).strict()).max(100),
  text: z.string().min(1).max(5_000),
}).strict();

function bearerMatches(header: string | undefined, password: string): boolean {
  const hasBearer = header?.startsWith('Bearer ') === true;
  const candidate = hasBearer ? header.slice('Bearer '.length) : '';
  const expectedHash = createHash('sha256').update(password).digest();
  const candidateHash = createHash('sha256').update(candidate).digest();
  const matches = timingSafeEqual(expectedHash, candidateHash);
  return hasBearer && matches;
}

function parseJsonBody<T>(body: unknown, schema: z.ZodType<T>): T | undefined {
  const result = schema.safeParse(body);
  return result.success ? result.data : undefined;
}

function decisionCostCny(detail: unknown): number | null {
  if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) return null;
  const costCny = (detail as Record<string, unknown>).costCny;
  return typeof costCny === 'number' && Number.isFinite(costCny) ? costCny : null;
}

export function createPanelApp(options: PanelServerOptions): Hono {
  if (!options.password) throw new Error('Panel password must not be empty');
  const root = options.root ?? process.cwd();
  const panelDist = options.panelDist ?? path.join(root, 'panel', 'dist');
  const now = options.now ?? Date.now;
  const app = new Hono();
  let configWriteTail: Promise<void> = Promise.resolve();
  const serializeConfigWrite = <T>(task: () => Promise<T>): Promise<T> => {
    const result = configWriteTail.then(task, task);
    configWriteTail = result.then(() => undefined, () => undefined);
    return result;
  };

  app.use('/api/*', bodyLimit({
    maxSize: 2 * 1024 * 1024,
    onError: (context) => context.json({ error: 'Request body too large' }, 413),
  }));
  app.use('/api/*', async (context, next) => {
    if (!bearerMatches(context.req.header('Authorization'), options.password)) {
      return context.json({ error: 'Unauthorized' }, 401);
    }
    await next();
  });
  registerPersonaRoutes(app, root);

  app.get('/api/status', async (context) => {
    const config = options.getConfig();
    const accounts = options.accounts();
    const enabled = await Promise.all(accounts.map((runtime) =>
      listEnabledSessions(runtime.adapter, config)));
    const todayCostCny = options.repository.costToday();
    return context.json({
      accounts: accounts.map((runtime) => {
        const accountConfig = config.accounts.find((candidate) => candidate.uin === runtime.adapter.account);
        const lastReply = options.repository.latestSelfMessageForAccount(runtime.adapter.account);
        return {
          account: runtime.adapter.account,
          name: runtime.getNickname(),
          persona: accountConfig?.persona ?? 'default',
          snowlumaConfigured: Boolean(accountConfig?.snowlumaDir),
          connectionStatus: runtime.getStatus(),
          todayReplyCount: options.repository.replyCountTodayForAccount(runtime.adapter.account),
          lastReplyAt: lastReply?.time ?? null,
          lastReplyText: lastReply?.plainText ?? null,
        };
      }),
      todayReplyCount: options.repository.replyCountToday(),
      todayCostCny,
      budgetState: {
        state: budgetState(config, todayCostCny),
        dailyLimitCny: config.budget.dailyCny,
        todayCostCny,
      },
      enabledSessionCount: new Set(enabled.flat().map(sessionId)).size,
      allMuted: options.management().length > 0 && options.management().every((commands) => commands.isAllMuted()),
      ownerConfigured: config.owner !== 0,
      runtime: { pid: process.pid, port: config.panel.port, uptimeSeconds: Math.floor(process.uptime()) },
    });
  });

  app.get('/api/sessions', async (context) => {
    const config = options.getConfig();
    const runtimes = options.accounts();
    const rows = new Map<string, { key: SessionKey; name: string; memberCount?: number }>();
    for (const runtime of runtimes) {
      try {
        const groups = await runtime.adapter.listGroups();
        for (const group of groups) {
          const key: SessionKey = { account: runtime.adapter.account, kind: 'group', peer: group.groupId };
          rows.set(sessionId(key), { key, name: group.name, memberCount: group.memberCount });
        }
      } catch (error) {
        options.onError?.(error);
      }
      try {
        const friends = await runtime.adapter.listFriends();
        for (const friend of friends) {
          const key: SessionKey = { account: runtime.adapter.account, kind: 'private', peer: friend.userId };
          rows.set(sessionId(key), { key, name: friend.remark || friend.nickname });
        }
      } catch (error) {
        options.onError?.(error);
      }
    }
    for (const configuredId of Object.keys(config.sessions)) {
      const key = parseSessionId(configuredId);
      if (key && runtimes.some((runtime) => runtime.adapter.account === key.account) && !rows.has(configuredId)) {
        rows.set(configuredId, { key, name: configuredId });
      }
    }
    const result = [...rows.entries()].map(([id, row]) => {
      const effective = resolveSession(config, row.key);
      return {
        sessionId: id,
        name: row.name,
        kind: row.key.kind,
        ...(row.memberCount === undefined ? {} : { memberCount: row.memberCount }),
        enabled: effective.enabled,
        overrides: Object.keys(config.sessions[id] ?? {}),
        effective: {
          mode: effective.mode,
          nicknames: effective.nicknames,
          contextMessages: effective.contextMessages,
          rate: effective.rate,
          groupNote: effective.groupNote,
        },
      };
    });
    result.sort((first, second) => first.name.localeCompare(second.name, 'zh-CN'));
    return context.json(result);
  });

  app.patch('/api/sessions/:sessionId', async (context) => {
    const id = context.req.param('sessionId');
    const key = parseSessionId(id);
    if (!key || !options.accounts().some((runtime) => runtime.adapter.account === key.account)) {
      return context.json({ error: 'Invalid session' }, 400);
    }
    let rawBody: unknown;
    try { rawBody = await context.req.json(); } catch { return context.json({ error: 'Invalid JSON' }, 400); }
    const patch = parseJsonBody(rawBody, sessionPatchSchema);
    if (!patch) return context.json({ error: 'Invalid session patch' }, 400);

    return serializeConfigWrite(async () => {
      const config = options.getConfig();
      const updated = { ...(config.sessions[id] ?? {}) } as Record<string, unknown>;
      for (const [field, value] of Object.entries(patch)) {
        if (field !== 'rate') {
          if (value === null) delete updated[field];
          else if (value !== undefined) updated[field] = value;
          continue;
        }
        if (value === null) {
          delete updated.rate;
          continue;
        }
        if (value) {
          const rate = { ...((updated.rate as Record<string, unknown> | undefined) ?? {}) };
          for (const [rateField, rateValue] of Object.entries(value)) {
            if (rateValue === null) delete rate[rateField];
            else if (rateValue !== undefined) rate[rateField] = rateValue;
          }
          if (Object.keys(rate).length === 0) delete updated.rate;
          else updated.rate = rate;
        }
      }
      const sessions = { ...config.sessions };
      if (Object.keys(updated).length === 0) delete sessions[id];
      else sessions[id] = updated as AquariumConfig['sessions'][string];
      const nextConfig = AquariumConfigSchema.parse({ ...config, sessions });
      await options.saveConfig(nextConfig);
      return context.json({
        sessionId: id,
        enabled: resolveSession(nextConfig, key).enabled,
        overrides: Object.keys(nextConfig.sessions[id] ?? {}),
      });
    });
  });


  app.get('/api/decisions', async (context) => {
    const rawLimit = context.req.query('limit');
    const requested = rawLimit === undefined ? 50 : Number(rawLimit);
    if (!Number.isSafeInteger(requested) || requested < 1) {
      return context.json({ error: 'Invalid limit' }, 400);
    }
    const decisions = options.repository.recentDecisions(Math.min(requested, 200));
    const sessionNames = new Map<string, string>();
    for (const runtime of options.accounts()) {
      try {
        const groups = await runtime.adapter.listGroups();
        for (const group of groups) {
          const id = sessionId({ account: runtime.adapter.account, kind: 'group', peer: group.groupId });
          sessionNames.set(id, group.name || id);
        }
      } catch (error) {
        options.onError?.(error);
      }
      try {
        const friends = await runtime.adapter.listFriends();
        for (const friend of friends) {
          const id = sessionId({ account: runtime.adapter.account, kind: 'private', peer: friend.userId });
          sessionNames.set(id, friend.remark || friend.nickname || id);
        }
      } catch (error) {
        options.onError?.(error);
      }
    }
    return context.json(decisions.map((decision) => ({
      ...decision,
      sessionName: sessionNames.get(decision.sessionId) ?? decision.sessionId,
      messageText: options.repository.decisionMessageText(decision.sessionId, decision.messageId) ?? null,
      costCny: decisionCostCny(decision.detail),
      hasDebugTrace: options.repository.hasDebugTrace(decision.sessionId, decision.messageId),
    })));
  });

  app.get('/api/decisions/:id/trace', (context) => {
    const id = Number(context.req.param('id'));
    if (!Number.isSafeInteger(id) || id < 1) return context.json({ error: 'Invalid decision ID' }, 400);
    const decision = options.repository.decisionById(id);
    if (!decision) return context.json({ error: 'Decision not found' }, 404);
    return context.json({
      decisionId: id,
      traces: options.repository.debugTracesFor(decision.sessionId, decision.messageId),
    });
  });

  app.get('/api/usage/today', (context) => context.json(options.repository.usageToday()));

  app.post('/api/sandbox/chat', async (context) => {
    let rawBody: unknown;
    try { rawBody = await context.req.json(); } catch { return context.json({ error: 'Invalid JSON' }, 400); }
    const body = parseJsonBody(rawBody, sandboxSchema);
    if (!body) return context.json({ error: 'Invalid sandbox request' }, 400);
    const key = parseSessionId(body.sessionId);
    const runtime = key && options.accounts().find((candidate) => candidate.adapter.account === key.account);
    if (!key || !runtime) return context.json({ error: 'Unknown session' }, 400);

    const config = options.getConfig();
    const asOwner = body.asOwner && config.owner !== 0;
    const settings = resolveSession(config, key);
    const accountConfig = config.accounts.find((candidate) => candidate.uin === key.account);
    const nickname = runtime.getNickname();
    const persona = loadPersona(accountConfig?.persona ?? 'default', nickname, { root });
    const nowTime = now();
    const nonOwnerId = config.owner === 1 ? 2 : 1;
    const contextMessages = body.history.map((message, index) => {
      const isSelf = message.role === 'bot';
      return {
        sessionId: body.sessionId,
        messageId: `sandbox-history-${index}`,
        senderId: isSelf ? key.account : asOwner ? config.owner : nonOwnerId,
        senderName: isSelf ? nickname : asOwner ? '主人' : '试聊用户',
        isSelf,
        plainText: message.text,
        segments: [{ type: 'text', text: message.text }],
        time: nowTime - (body.history.length - index) * 1_000,
      };
    });
    contextMessages.push({
      sessionId: body.sessionId,
      messageId: 'sandbox-current',
      senderId: asOwner ? config.owner : nonOwnerId,
      senderName: asOwner ? '主人' : '试聊用户',
      isSelf: false,
      plainText: body.text,
      segments: [{ type: 'text', text: body.text }],
      time: nowTime,
    });
    const prompt = buildPromptMessages({
      persona,
      ownerId: config.owner,
      groupNote: settings.groupNote,
      context: contextMessages,
    });
    const modelCall = options.callModel ?? callSlot;
    const result = await modelCall('reply', prompt, {
      config,
      costToday: options.repository.costToday,
      recordUsage: (usage) => options.repository.recordUsage(usage),
    });
    const text = cleanReply(result.text, [nickname, ...settings.nicknames]);
    const parts = splitReply(text);
    return context.json({
      parts,
      decisionSteps: [
        { step: 'settings', status: 'loaded', enabled: settings.enabled, mode: settings.mode },
        { step: 'prompt', status: 'assembled', asOwner },
        { step: 'reply', status: text ? 'completed' : 'empty', provider: result.provider, model: result.model },
        { step: 'split', status: 'completed', partCount: parts.length },
      ],
      usage: { provider: result.provider, model: result.model, ...result.usage },
    });
  });

  app.post('/api/recall/:messageId', async (context) => {
    const messageId = context.req.param('messageId');
    const matches = options.repository.selfMessagesById(messageId);
    if (matches.length === 0) return context.json({ error: 'Self message not found' }, 404);
    if (matches.length > 1) return context.json({ error: 'Message ID is ambiguous' }, 409);
    const key = parseSessionId(matches[0]?.sessionId ?? '');
    const runtime = key && options.accounts().find((candidate) => candidate.adapter.account === key.account);
    if (!key || !runtime) return context.json({ error: 'Adapter not found' }, 404);
    await runtime.adapter.recall(messageId);
    return context.json({ recalled: true, messageId });
  });

  app.post('/api/mute-all', (context) => {
    for (const commands of options.management()) commands.muteAll();
    return context.json({ muted: true });
  });

  app.post('/api/unmute-all', (context) => {
    for (const commands of options.management()) commands.unmuteAll();
    return context.json({ muted: false });
  });

  app.all('/api/*', (context) => context.json({ error: 'Not found' }, 404));

  app.onError((error, context) => {
    options.onError?.(error);
    return context.json({ error: 'Internal server error' }, 500);
  });

  app.use('*', serveStatic({ root: panelDist }));
  app.get('*', (context) => {
    const indexPath = path.join(panelDist, 'index.html');
    if (!existsSync(indexPath)) return context.text('Panel build not found', 503);
    return context.html(readFileSync(indexPath, 'utf8'));
  });

  return app;
}
