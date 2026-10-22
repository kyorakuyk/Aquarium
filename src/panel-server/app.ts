import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { serveStatic } from '@hono/node-server/serve-static';
import { z } from 'zod';
import type { ContactFriend, ContactGroup, ProtocolAdapter } from '../adapters/types.ts';
import type { AquariumConfig } from '../config/schema.ts';
import { resolveSession } from '../config/resolve.ts';
import { parseSessionId, listEnabledSessions } from '../core/conversation/sessions.ts';
import { sessionId, type IncomingMessage, type Segment, type SessionKey } from '../core/shared/events.ts';
import { buildPromptMessages } from '../core/prompt/index.ts';
import { cleanReply } from '../core/shared/text.ts';
import { splitReply } from '../core/shared/split.ts';
import { promptTemplateStore } from '../core/prompt/templates.ts';
import type { PipelineModelCall, PipelineResult } from '../core/conversation/pipeline.ts';
import { prepareSandboxPersona } from './sandbox-persona.ts';
import type { ManagementCommands } from '../core/conversation/management.ts';
import type { StoreRepository } from '../store/repository.ts';
import { callSlot } from '../llm/slots.ts';
import { registerPersonaRoutes } from './personas.ts';
import { registerSessionRoutes } from './session-routes.ts';
import { registerAffectRoutes } from './affect-routes.ts';
import { registerPrivacyRoutes } from './privacy-routes.ts';
import { registerSleepRoutes } from './sleep-routes.ts';
import { registerUsageRoutes } from './usage-routes.ts';
import { registerProviderRoutes } from './provider-routes.ts';
import type { CliRuntime } from '../llm/cli.ts';
import type { ContactSnapshot, PanelAccountRuntime } from './types.ts';
import { budgetState } from '../llm/budget.ts';
import type { SleepWakeState } from '../core/sleep/index.ts';
import type { HistoryImportService } from '../core/impressions/history-import.ts';
import type { ImpressionsService } from '../core/impressions/service.ts';
import type { TagClassificationService } from '../core/impressions/classify-tags.ts';
import type { StickerService } from '../core/stickers/service.ts';
import { registerStickerRoutes } from './sticker-routes.ts';
import { registerTagClassificationRoutes } from './tag-classification-routes.ts';
import { registerActivityRoutes } from './activity-routes.ts';
import type { ProfileActivityService } from '../core/profiles/presence-service.ts';
import type { TagSubjectRepository } from '../store/tag-subject-repo.ts';
import type { MemberSummaryRepository } from '../store/member-summary-repo.ts';
import { registerTagSubjectRoutes } from './tag-subject-routes.ts';
import { registerTagVetoRoutes } from './tag-veto-routes.ts';
import { registerMemberSummaryRoutes } from './member-summary-routes.ts';
import { registerGroupSummaryRoutes } from './group-summary-routes.ts';
import { registerIdentityRoutes } from './identity-routes.ts';
import { registerImpressionsDataRoutes } from './impressions-data-routes.ts';
import { registerImpressionsStatusRoutes } from './impressions-status-routes.ts';

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
  adapterTimeoutMs?: number;
  callModel?: PipelineModelCall;
  replayMessage?: (message: IncomingMessage) => Promise<PipelineResult | undefined>;
  sleepWakeState?: SleepWakeState;
  historyImports?: HistoryImportService;
  impressionsService?: ImpressionsService;
  tagClassificationService?: TagClassificationService;
  profileActivity?: ProfileActivityService;
  tagSubjects?: TagSubjectRepository;
  memberSummaryRepository?: MemberSummaryRepository;
  stickerServices?: () => StickerService[];
  envPath?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  testProvider?: (provider: string, model: string, config: AquariumConfig) => Promise<{ ok: boolean; latencyMs: number; error?: string }>;
  cliRuntime?: CliRuntime;
  onError?: (error: unknown, context?: { method?: string; path?: string; stage?: string }) => void;
}

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

interface ContactCache {
  groups?: ContactGroup[];
  friends?: ContactFriend[];
  groupsRequest?: Promise<ContactGroup[]>;
  friendsRequest?: Promise<ContactFriend[]>;
}

const DEFAULT_ADAPTER_TIMEOUT_MS = 3_000;

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
  const adapterTimeoutMs = options.adapterTimeoutMs ?? DEFAULT_ADAPTER_TIMEOUT_MS;
  if (!Number.isSafeInteger(adapterTimeoutMs) || adapterTimeoutMs <= 0) {
    throw new TypeError('Panel adapter timeout must be a positive integer');
  }
  const contactCaches = new WeakMap<ProtocolAdapter, ContactCache>();
  const contactCacheFor = (adapter: ProtocolAdapter): ContactCache => {
    let cache = contactCaches.get(adapter);
    if (!cache) {
      cache = {};
      contactCaches.set(adapter, cache);
    }
    return cache;
  };
  const requestGroups = (runtime: PanelAccountRuntime, cache: ContactCache): Promise<ContactGroup[]> => {
    if (cache.groupsRequest) return cache.groupsRequest;
    let request!: Promise<ContactGroup[]>;
    request = Promise.resolve().then(() => {
      if (runtime.getStatus() !== 'online') throw new Error('Adapter went offline before group contact lookup');
      return runtime.adapter.listGroups();
    }).then((groups) => {
      cache.groups = groups;
      return groups;
    }).finally(() => {
      if (cache.groupsRequest === request) delete cache.groupsRequest;
    });
    cache.groupsRequest = request;
    return request;
  };
  const requestFriends = (runtime: PanelAccountRuntime, cache: ContactCache): Promise<ContactFriend[]> => {
    if (cache.friendsRequest) return cache.friendsRequest;
    let request!: Promise<ContactFriend[]>;
    request = Promise.resolve().then(() => {
      if (runtime.getStatus() !== 'online') throw new Error('Adapter went offline before friend contact lookup');
      return runtime.adapter.listFriends();
    }).then((friends) => {
      cache.friends = friends;
      return friends;
    }).finally(() => {
      if (cache.friendsRequest === request) delete cache.friendsRequest;
    });
    cache.friendsRequest = request;
    return request;
  };
  const readContact = async <T>(
    request: Promise<T>,
    cached: T | undefined,
    clearRequest: () => void,
    label: string,
  ): Promise<{ value: T | undefined; degraded: boolean }> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error(`Panel ${label} contact lookup timed out after ${adapterTimeoutMs}ms`));
      }, adapterTimeoutMs);
    });
    try {
      return { value: await Promise.race([request, timeout]), degraded: false };
    } catch (error) {
      if (timedOut) clearRequest();
      options.onError?.(error, { stage: `读取 QQ ${label} 联系人` });
      return { value: cached, degraded: true };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  const loadContacts = async (runtime: PanelAccountRuntime): Promise<ContactSnapshot> => {
    const cache = contactCacheFor(runtime.adapter);
    if (runtime.getStatus() !== 'online') {
      return { groups: cache.groups ?? [], friends: cache.friends ?? [], degraded: true };
    }
    const groupsRequest = requestGroups(runtime, cache);
    const friendsRequest = requestFriends(runtime, cache);
    const [groups, friends] = await Promise.all([
      readContact(groupsRequest, cache.groups, () => {
        if (cache.groupsRequest === groupsRequest) delete cache.groupsRequest;
      }, 'group'),
      readContact(friendsRequest, cache.friends, () => {
        if (cache.friendsRequest === friendsRequest) delete cache.friendsRequest;
      }, 'friend'),
    ]);
    return {
      groups: groups.value ?? cache.groups ?? [],
      friends: friends.value ?? cache.friends ?? [],
      degraded: groups.degraded || friends.degraded || runtime.getStatus() !== 'online',
    };
  };

  const standardBodyLimit = bodyLimit({
    maxSize: 2 * 1024 * 1024,
    onError: (context) => context.json({ error: 'Request body too large' }, 413),
  });
  const stickerUploadBodyLimit = bodyLimit({
    maxSize: 7 * 1024 * 1024,
    onError: (context) => context.json({ error: 'Request body too large' }, 413),
  });
  app.use('/api/*', (context, next) => (
    context.req.path === '/api/stickers/upload'
      ? stickerUploadBodyLimit(context, next)
      : standardBodyLimit(context, next)
  ));
  app.use('/api/*', async (context, next) => {
    if (!bearerMatches(context.req.header('Authorization'), options.password)) {
      return context.json({ error: 'Unauthorized' }, 401);
    }
    await next();
  });
  registerStickerRoutes(app, {
    root,
    repository: options.repository,
    accounts: options.accounts,
    services: options.stickerServices ?? (() => []),
    now,
    getConfig: options.getConfig,
    saveConfig: options.saveConfig,
    serializeConfigWrite,
  });
  registerPersonaRoutes(app, root, {
    getConfig: options.getConfig,
    repository: options.repository,
    callModel: options.callModel,
  });
  registerSessionRoutes(app, {
    getConfig: options.getConfig,
    saveConfig: options.saveConfig,
    repository: options.repository,
    accounts: options.accounts,
    loadContacts,
    serializeConfigWrite,
  });
  registerImpressionsDataRoutes(app, {
    root,
    getConfig: options.getConfig,
    repository: options.repository,
    accounts: options.accounts,
    loadContacts,
    ...(options.tagSubjects ? { tagSubjects: options.tagSubjects } : {}),
    ...(options.memberSummaryRepository ? { summaries: options.memberSummaryRepository } : {}),
    now,
  });
  registerAffectRoutes(app, {
    getConfig: options.getConfig,
    repository: options.repository,
    accounts: options.accounts,
    sleepWakeState: options.sleepWakeState,
    historyImports: options.historyImports,
    now,
  });
  registerImpressionsStatusRoutes(app, {
    accounts: options.accounts,
    impressionsService: options.impressionsService,
  });
  registerIdentityRoutes(app, { getConfig: options.getConfig, repository: options.repository, now });
  registerGroupSummaryRoutes(app, { getConfig: options.getConfig, repository: options.repository, now });
  registerTagVetoRoutes(app, options.repository);
  if (options.tagSubjects) {
    registerTagSubjectRoutes(app, {
      getConfig: options.getConfig,
      tagSubjects: options.tagSubjects,
    });
  }
  if (options.memberSummaryRepository) {
    registerMemberSummaryRoutes(app, {
      getConfig: options.getConfig,
      repository: options.repository,
      summaries: options.memberSummaryRepository,
      now,
    });
  }
  registerTagClassificationRoutes(app, options.tagClassificationService);
  if (options.profileActivity) {
    registerActivityRoutes(app, {
      getConfig: options.getConfig,
      saveConfig: options.saveConfig,
      repository: options.repository,
      profileActivity: options.profileActivity,
      now,
      serializeConfigWrite,
    });
  }
  registerPrivacyRoutes(app, {
    getConfig: options.getConfig,
    repository: options.repository,
    accounts: options.accounts,
    now,
  });
  registerSleepRoutes(app, {
    getConfig: options.getConfig,
    saveConfig: options.saveConfig,
    repository: options.repository,
    account: () => options.accounts()[0]?.adapter.account ?? null,
    sleepWakeState: options.sleepWakeState,
    now,
    serializeConfigWrite,
  });
  registerUsageRoutes(app, {
    getConfig: options.getConfig,
    repository: options.repository,
    now,
  });
  registerProviderRoutes(app, {
    getConfig: options.getConfig,
    saveConfig: options.saveConfig,
    repository: options.repository,
    serializeConfigWrite,
    envPath: options.envPath ?? path.join(root, '.env'),
    env: options.env ?? process.env,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    now,
    testProvider: options.testProvider,
    cliRuntime: options.cliRuntime,
  });

  app.get('/api/status', async (context) => {
    const config = options.getConfig();
    const accounts = options.accounts();
    const contacts = await Promise.all(accounts.map(loadContacts));
    const enabled = await Promise.all(accounts.map((runtime, index) => {
      const snapshot = contacts[index] ?? { groups: [], friends: [], degraded: true };
      return listEnabledSessions(runtime.adapter, config, (error) => {
        options.onError?.(error, { method: 'GET', path: '/api/status', stage: '查询已启用会话' });
      }, snapshot);
    }));
    const todayCostCny = options.repository.costToday();
    return context.json({
      accounts: accounts.map((runtime, index) => {
        const accountConfig = config.accounts.find((candidate) => candidate.uin === runtime.adapter.account);
        const lastReply = options.repository.latestSelfMessageForAccount(runtime.adapter.account);
        const currentStatus = runtime.getStatus();
        const snapshot = contacts[index];
        return {
          account: runtime.adapter.account,
          name: runtime.getNickname(),
          persona: accountConfig?.persona ?? 'default',
          snowlumaConfigured: Boolean(accountConfig?.snowlumaDir),
          connectionStatus: currentStatus,
          connectionHint: runtime.getConnectionHint?.() ?? null,
          degraded: !snapshot || snapshot.degraded || currentStatus !== 'online',
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

  app.get('/api/decisions', async (context) => {
    const rawLimit = context.req.query('limit');
    const requested = rawLimit === undefined ? 50 : Number(rawLimit);
    if (!Number.isSafeInteger(requested) || requested < 1) {
      return context.json({ error: 'Invalid limit' }, 400);
    }
    const decisions = options.repository.recentDecisions(Math.min(requested, 200));
    const sessionNames = new Map<string, string>();
    const runtimes = options.accounts();
    const snapshots = await Promise.all(runtimes.map(loadContacts));
    for (const [index, runtime] of runtimes.entries()) {
      const snapshot = snapshots[index] ?? { groups: [], friends: [], degraded: true };
      for (const group of snapshot.groups) {
        const id = sessionId({ account: runtime.adapter.account, kind: 'group', peer: group.groupId });
        sessionNames.set(id, group.name || id);
      }
      for (const friend of snapshot.friends) {
        const id = sessionId({ account: runtime.adapter.account, kind: 'private', peer: friend.userId });
        sessionNames.set(id, friend.remark || friend.nickname || id);
      }
    }
    return context.json(decisions.map((decision) => ({
      ...decision,
      sessionName: sessionNames.get(decision.sessionId) ?? decision.sessionId,
      messageText: options.repository.decisionMessageText(decision.sessionId, decision.messageId) ?? null,
      costCny: decisionCostCny(decision.detail),
      hasDebugTrace: options.repository.hasDebugTrace(decision.sessionId, decision.messageId),
      hasPipelineTrace: options.repository.hasPipelineTrace(decision.sessionId, decision.messageId),
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

  app.get('/api/decisions/:id/pipeline-trace', (context) => {
    const id = Number(context.req.param('id'));
    if (!Number.isSafeInteger(id) || id < 1) return context.json({ error: 'Invalid decision ID' }, 400);
    const decision = options.repository.decisionById(id);
    if (!decision) return context.json({ error: 'Decision not found' }, 404);
    const stored = options.repository.pipelineTraceFor(decision.sessionId, decision.messageId);
    return context.json({ decisionId: id, trace: stored?.trace ?? [] });
  });

  app.post('/api/decisions/:id/replay', async (context) => {
    const id = Number(context.req.param('id'));
    if (!Number.isSafeInteger(id) || id < 1) return context.json({ error: 'Invalid decision ID' }, 400);
    const decision = options.repository.decisionById(id);
    if (!decision) return context.json({ error: 'Decision not found' }, 404);
    if (!options.replayMessage) return context.json({ error: 'Replay is unavailable' }, 501);

    const key = parseSessionId(decision.sessionId);
    if (!key) return context.json({ error: 'Decision session is invalid' }, 409);
    const storedMessage = options.repository.messageBySessionAndId(decision.sessionId, decision.messageId);
    if (!storedMessage || !Array.isArray(storedMessage.segments)) {
      return context.json({ error: 'Original message is unavailable' }, 409);
    }
    const segments = storedMessage.segments as Segment[];
    const message: IncomingMessage = {
      session: key,
      messageId: storedMessage.messageId,
      senderId: storedMessage.senderId,
      senderName: storedMessage.senderName,
      segments,
      plainText: storedMessage.plainText,
      mentionsSelf: segments.some((segment) => {
        if (typeof segment !== 'object' || segment === null || Array.isArray(segment)) return false;
        const candidate = segment as Record<string, unknown>;
        return candidate.type === 'at' && candidate.target === key.account;
      }),
      replyToSelf: false,
      time: storedMessage.time,
    };
    const result = await options.replayMessage(message);
    if (!result) return context.json({ error: 'Replay account is unavailable' }, 409);
    if (!result.replay) return context.json({ error: 'Replay result is unavailable' }, 500);

    const originalTrace = options.repository.pipelineTraceFor(decision.sessionId, decision.messageId);
    return context.json({
      decisionId: id,
      original: {
        replied: decision.replied,
        reason: decision.reason,
        replyCostCny: decisionCostCny(decision.detail),
        trace: originalTrace?.trace ?? [],
      },
      replay: result.replay,
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
    const sandboxPersona = prepareSandboxPersona({ personaId: accountConfig?.persona ?? 'default', nickname, root, asOwner, settings, body,
      traitsTemplate: promptTemplateStore.get().traits });
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
      persona: sandboxPersona.prompt,
      ownerId: config.owner,
      groupNote: settings.groupNote,
      context: contextMessages,
      blocks: { traits: sandboxPersona.traitsBlock },
    });
    const modelCall = options.callModel ?? callSlot;
    const result = await modelCall('reply', prompt, {
      config,
      account: key.account,
      costToday: options.repository.costToday,
      recordUsage: (usage) => options.repository.recordUsage({ ...usage, account: key.account }),
    });
    const text = cleanReply(result.text, [nickname, ...settings.nicknames]);
    const parts = splitReply(text, sandboxPersona.maxParts, sandboxPersona.maxPartLength);
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
    const request = context.req.raw;
    options.onError?.(error, {
      method: request.method,
      path: new URL(request.url).pathname,
      stage: '面板路由处理',
    });
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
