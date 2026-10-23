import path from 'node:path';
import { OneBotAdapter } from '../adapters/onebot/adapter.ts';
import type { AdapterStatus } from '../adapters/types.ts';
import { loadConfig } from '../config/load.ts';
import { watchConfig } from '../config/watch.ts';
import { writeConfig } from '../config/write.ts';
import { resolveSession } from '../config/resolve.ts';
import { createLogger } from '../core/shared/logger.ts';
import { createMessagePipeline } from '../core/conversation/pipeline.ts';
import { bindPromptTemplateReload, promptTemplateStore } from '../core/prompt/templates.ts';
import { createHistoryCatchUp } from '../core/conversation/history-catchup.ts';
import { createManagementCommands } from '../core/conversation/management.ts';
import type { ManagementCommands } from '../core/conversation/management.ts';
import { sessionId } from '../core/shared/events.ts';
import { createSessionQueue } from '../core/conversation/session-queue.ts';
import { createAffinityService } from '../core/affinity/service.ts';
import { createMoodService } from '../core/mood/service.ts';
import { createSleepWakeState } from '../core/sleep/index.ts';
import { createSleepGoodnightScheduler } from '../core/sleep/goodnight.ts';
import { getCliRuntime } from '../llm/cli.ts';
import { openDatabase } from '../store/db.ts';
import { createRepository } from '../store/repository.ts';
import { createActivitySuggestionRepository } from '../store/activity-suggestion-repo.ts';
import { createMemberSummaryRepository } from '../store/member-summary-repo.ts';
import { createTagSubjectRepository } from '../store/tag-subject-repo.ts';
import { createTagClassificationRepository } from '../store/tag-classification-repo.ts';
import { startPanelServer, type PanelAccountRuntime } from '../panel-server/server.ts';
import { bootstrapHost, runStartupTasks } from '../host/bootstrap.ts';
import { startPanelWhileAccountStartupRuns } from './startup-order.ts';
import type { Host } from '../host/types.ts';
import { bindHostTrayAfterLoad, createWindowsTray } from '../host/tray.ts';
import { createWindowsHost } from '../host/windows/host.ts';
import { createAccountActivityRouter } from './activity-routing.ts';
import { createMemoryServices } from './memory-services.ts';
import { createQueuedPersonaMemoryProcessor } from './persona-memory-processor.ts';
import { createAccountStickerService, startStickerSyncTimer } from './stickers.ts';
import { startAdapterForHost } from './adapter-start.ts';
import { createProfileActivityService } from '../core/profiles/presence-service.ts';
import { createPersonaMemoryService } from '../core/persona-memory.ts';
import { loadPersona } from '../persona/load.ts';
import { startProfileActivitySchedule } from './profile-activity.ts';
import {
  createHostLifecycleQueue,
  createSnowLumaRestartHandler,
  createTrayMenuActionHandler,
} from '../host/windows/tray-actions.ts';
import { describeError } from './error-description.ts';
import { isPanelPortOccupied } from './panel-instance-guard.ts';
import { createOnlineStartupTasks } from './online-startup-tasks.ts';
import { acquireInstanceLock } from './instance-lock.ts';

const logger = createLogger('app');
const instanceLock = acquireInstanceLock({
  lockPath: path.join(process.cwd(), 'data', 'aquarium.lock'),
  onLog: (level, message) => {
    if (level === 'error') logger.error(message);
    else if (level === 'warn') logger.warn(message);
    else logger.info(message);
  },
  onLost: () => { void shutdown('单实例锁丢失'); },
});
if (!instanceLock.allowed) {
  logger.error(`启动被拒：${instanceLock.reason}`);
  process.exit(1);
}
logger.info(`单实例锁：${instanceLock.reason}${instanceLock.degraded ? '（degraded 放行）' : ''}`);
process.once('exit', instanceLock.release);
const configPath = path.join(process.cwd(), 'data', 'config.yaml');
const initialConfig = loadConfig({ configPath });
if (await isPanelPortOccupied(initialConfig.panel.host, initialConfig.panel.port)) {
  logger.error(
    `管理面板地址 ${initialConfig.panel.host}:${initialConfig.panel.port} 已被占用，可能已有 Aquarium 实例运行；为避免重复连接同一 SnowLuma，当前进程退出。`,
  );
  instanceLock.release();
  process.exit(1);
}
const database = openDatabase();
const repository = createRepository(database);
const memberSummaryRepository = createMemberSummaryRepository(database);
const tagSubjects = createTagSubjectRepository(database);
const configWatcher = watchConfig({ initialConfig, configPath });
const cliRuntime = getCliRuntime();
cliRuntime.sync(initialConfig.providers);
function pruneTraces(): void {
  try {
    const config = configWatcher.getConfig();
    const now = Date.now();
    const deletedDebug = repository.pruneDebugTraces(now, config.debug.retainDays);
    const deletedPipeline = repository.prunePipelineTraces(now, config.debug.retainDays);
    const deleted = deletedDebug + deletedPipeline;
    if (deleted > 0) logger.info(`已清理过期调试记录：${deleted} 条（模型 ${deletedDebug}，流水线 ${deletedPipeline}）。`);
  } catch (error) {
    logger.error(`清理过期调试记录失败：${describeError(error)}`);
  }
}
pruneTraces();
const debugPruneTimer = setInterval(pruneTraces, 6 * 60 * 60 * 1000);
debugPruneTimer.unref();
const adapters: OneBotAdapter[] = [];
const stickerServices: ReturnType<typeof createAccountStickerService>[] = [];
const injectedUins = new Set<number>();
const panelAccounts: PanelAccountRuntime[] = [];
const managementControllers: ManagementCommands[] = [];
const pipelines = new Map<number, ReturnType<typeof createMessagePipeline>>();
const subscriptions: Array<() => void> = [];
subscriptions.push(bindPromptTemplateReload(configWatcher, promptTemplateStore, (error) => {
  logger.error(`提示词模板热重载失败，继续使用上一份有效模板：${describeError(error)}`);
}));
const adapterStatuses = new Map<number, AdapterStatus>();
const sessionQueue = createSessionQueue();
const sleepWakeState = createSleepWakeState();
const sleepOrganizationTasks = new Set<Promise<void>>();
const affinityService = createAffinityService({
  repository,
  getConfig: () => configWatcher.getConfig(),
});
function energySourceForAccount(account: number) {
  const config = configWatcher.getConfig();
  const personaId = config.accounts.find((entry) => entry.uin === account)?.persona ?? 'default';
  try {
    return loadPersona(personaId, '').energySource;
  } catch {
    return 'mixed' as const;
  }
}
const moodService = createMoodService({
  repository,
  getConfig: () => configWatcher.getConfig(),
  getEnergySource: energySourceForAccount,
  affinityService,
  onError: (error) => {
    logger.error(`情绪后台任务失败：${describeError(error)}`);
  },
});
const profileActivityService = createProfileActivityService({
  repository,
  suggestionRepository: createActivitySuggestionRepository(database),
  getConfig: () => configWatcher.getConfig(),
});
subscriptions.push(startProfileActivitySchedule({
  service: profileActivityService,
  onError: (error) => logger.error(`作息统计更新失败：${describeError(error)}`),
}));
const { impressionsService, memberSummaryService, groupSummaryService, tagClassificationService, privateFactsService, privateMentionService, privacyGateService, historyImports } = createMemoryServices({
  repository,
  memberSummaryRepository,
  tagSubjects,
  tagClassificationRepository: createTagClassificationRepository(database),
  getConfig: () => configWatcher.getConfig(),
  logger,
  describeError,
});
tagClassificationService.startOnStartup();
const processPersonaMemorySession = createQueuedPersonaMemoryProcessor({
  isSessionEnabled: (session) => resolveSession(configWatcher.getConfig(), session).enabled,
  process: async (session, records, now) => {
    if (session.kind === 'group') {
      const key = sessionId(session);
      const release = impressionsService.tryAcquireSession(key);
      if (!release) return 'failed';
      try {
        for (const record of records) {
          if (record.isSelf) continue;
          privateMentionService.maybePromote({
            session,
            senderId: record.senderId,
            messageId: record.messageId,
            now: record.time,
            template: promptTemplateStore.get().privacyMention,
          });
        }
        await privateMentionService.idle();
        const summary = await impressionsService.extractWindowUnderSessionLock({
          session,
          records,
          now,
          template: promptTemplateStore.get().extractTags,
        });
        return summary.status === 'done' ? 'done' : summary.status === 'budget' ? 'budget' : 'failed';
      } finally {
        release();
      }
    }
    const summary = await privateFactsService.extractWindowUnderSessionLock({
      session,
      records,
      now,
      template: promptTemplateStore.get().extractPrivate,
    });
    return summary.status === 'done' ? 'done' : summary.status === 'budget' ? 'budget' : 'failed';
  },
});
const personaMemoryService = createPersonaMemoryService({
  repository,
  getConfig: () => configWatcher.getConfig(),
  canProcessSession: (session) => resolveSession(configWatcher.getConfig(), session).enabled,
  processSession: processPersonaMemorySession,
  onError: () => logger.error('夜间人格记忆整理失败；未完成的 memo 保留待下次重试。'),
});
const sleepGoodnightScheduler = createSleepGoodnightScheduler({
  getConfig: () => configWatcher.getConfig(),
  adapters: () => adapters,
  repository,
  getGoodnightLines: () => promptTemplateStore.get().sleep.goodnight,
  sendGoodnight: (session, text, cycleKey) => {
    const pipeline = pipelines.get(session.account);
    if (!pipeline) return Promise.resolve(false);
    return sessionQueue.run(sessionId(session), () => pipeline.sendSystemReply(session, text, cycleKey));
  },
  onSleep: async (cycleKey, now) => {
    const task = (async () => {
      for (const account of configWatcher.getConfig().accounts) {
        try {
          const result = await personaMemoryService.organizeAtSleep({ account: account.uin, cycleKey, now });
          if (result.status === 'budget') logger.warn(`账号 ${account.uin} 夜间整理因预算超限跳过。`);
          else if (result.status === 'partial') logger.warn(`账号 ${account.uin} 本轮夜间整理未完成，剩余 memo 留待下个睡眠周期。`);
          else if (result.status === 'failed') logger.error(`账号 ${account.uin} 夜间整理失败；待处理 memo 保留。`);
        } catch {
          logger.error(`账号 ${account.uin} 夜间整理失败；待处理 memo 保留。`);
        }
      }
    })();
    sleepOrganizationTasks.add(task);
    try {
      await task;
    } finally {
      sleepOrganizationTasks.delete(task);
    }
  },
  onError: (error) => logger.error(`定时晚安发送失败：${describeError(error)}`),
});
subscriptions.push(sleepGoodnightScheduler.start());
let panelServer: ReturnType<typeof startPanelServer> | undefined;
let managedHost: Host | undefined;
let shuttingDown = false;
const hostLifecycle = createHostLifecycleQueue();
const restartSnowLuma = createSnowLumaRestartHandler({
  lifecycle: hostLifecycle,
  getHost: () => managedHost,
  isShuttingDown: () => shuttingDown,
});

function hasEnabledSession(config: typeof initialConfig): boolean {
  return config.defaults.enabled || Object.values(config.sessions).some((session) => session.enabled === true);
}

function accountSignature(config: typeof initialConfig): string {
  return JSON.stringify(config.accounts.map(({ uin, snowlumaDir }) => [uin, snowlumaDir]));
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`收到 ${signal}，正在关闭 Aquarium。`);
  for (const unsubscribe of subscriptions) unsubscribe();
  panelServer?.close();
  for (const adapter of adapters) adapter.close();
  configWatcher.close();
  clearInterval(debugPruneTimer);
  try {
    await hostLifecycle.idle();
    await managedHost?.stop();
  } catch (error) {
    logger.error(`Windows 托管关闭失败：${describeError(error)}`);
  }
  while (sleepOrganizationTasks.size > 0) {
    await Promise.all([...sleepOrganizationTasks].map((task) => task.catch(() => undefined)));
  }
  await sessionQueue.idle();
  await impressionsService.idle();
  await memberSummaryService.idle();
  await groupSummaryService.idle();
  await tagClassificationService.idle();
  await privateFactsService.idle();
  await privateMentionService.idle();
  await cliRuntime.stopAll();
  database.close();
  instanceLock.release();
  logger.info('Aquarium 已关闭。');
}

process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });

configWatcher.on('changed', (config) => {
  cliRuntime.sync(config.providers);
  logger.info('配置已热重载；后续收到的消息将使用新配置。');
  if (!hasEnabledSession(config)) logger.warn('当前没有启用任何会话。');
  if (accountSignature(config) !== accountSignature(initialConfig)) {
    logger.warn('账号列表或 SnowLuma 路径已变化；现有连接不会自动重建，请重启 Aquarium。');
  }
});

if (!hasEnabledSession(initialConfig)) logger.warn('当前没有启用任何会话。');
if (initialConfig.accounts.length === 0) logger.warn('配置中没有账号，当前不会连接 OneBot。');

if (initialConfig.host.enabled && initialConfig.accounts.length === 0) {
  logger.warn('host.enabled=true 但没有配置账号，跳过 Windows 托管。');
} else {
  managedHost = await bootstrapHost({
    enabled: initialConfig.host.enabled,
    platform: process.platform,
    onHostCreated: (host) => { managedHost = host; },
    shouldContinue: () => !shuttingDown,
    createWindowsHost: () => createWindowsHost({
      accounts: initialConfig.accounts,
      settings: initialConfig.host,
      password: process.env.SNOWLUMA_WEBUI_PASSWORD ?? '',
      logDirectory: path.join(process.cwd(), 'data', 'logs'),
      getAdapterStatus: (uin) => adapterStatuses.get(uin),
      onAdapterInjected: (uin) => {
        injectedUins.add(uin);
        adapters.find((adapter) => adapter.account === uin)?.retryNow();
      },
      log: (level, message) => logger[level](message),
    }),
    onWarning: (message) => logger.warn(message),
    onStartError: (error) => logger.error(`Windows 托管启动失败；Aquarium 继续运行：${describeError(error)}`),
    onStopError: (error) => logger.error(`Windows 托管启动取消后的清理失败：${describeError(error)}`),
  });
  if (!shuttingDown && managedHost) {
    const hostForTray = managedHost;
    subscriptions.push(hostForTray.onStatus((status, message) => {
      logger.info(`Windows 托管状态：${status}${message ? `；${message}` : ''}`);
      if (status === 'online') {
        for (const adapter of adapters) {
          if (adapterStatuses.get(adapter.account) === 'waiting_login') adapter.retryNow();
        }
      }
    }));
    const onTrayMenu = createTrayMenuActionHandler({
      panelPort: initialConfig.panel.port,
      qqExePath: initialConfig.host.qqExePath,
      restartSnowLuma,
      getManagement: () => managementControllers,
      isShuttingDown: () => shuttingDown,
      quit: () => shutdown('托盘'),
      logError: (message) => logger.error(message),
    });
    try {
      const trayBinding = await bindHostTrayAfterLoad({
        host: hostForTray,
        loadTray: () => createWindowsTray({
          assetsDirectory: path.join(process.cwd(), 'assets', 'tray'),
          qqExePath: initialConfig.host.qqExePath,
          isAllMuted: () => managementControllers.length > 0
            && managementControllers.every((management) => management.isAllMuted()),
          logError: (message) => logger.error(message),
        }),
        shouldContinue: () => !shuttingDown && managedHost === hostForTray,
        onMenu: onTrayMenu,
      });
      if (trayBinding) subscriptions.push(trayBinding);
    } catch (error) {
      if (!shuttingDown) logger.error(`系统托盘启动失败；Aquarium 继续运行：${describeError(error)}`);
    }
  }
}

const accountStartup = runStartupTasks(initialConfig.accounts, () => !shuttingDown, async (accountConfig) => {
  let adapter: OneBotAdapter;
  try {
    adapter = new OneBotAdapter({
      account: accountConfig.uin,
      snowlumaDir: accountConfig.snowlumaDir,
      getSendDedupeWindowMs: () => configWatcher.getConfig().send.dedupeWindowMs,
      onDebug: (message) => logger.debug(message),
      onConnectionError: (error) => {
        logger.error(`OneBot 连接异常，将继续重试：${describeError(error)}`);
      },
    });
  } catch (error) {
    logger.error(`账号 ${accountConfig.uin} 的 OneBot 适配器初始化失败：${describeError(error)}`);
    return;
  }

  adapters.push(adapter);
  let currentStatus: AdapterStatus = managedHost ? 'waiting_login' : 'connecting';
  const stickerService = createAccountStickerService({
    adapter,
    root: process.cwd(),
    repository,
    getConfig: () => configWatcher.getConfig(),
    getPromptTemplate: () => promptTemplateStore.get().stickerDescribe,
    onError: () => logger.error('表情库同步或处理失败；后续同步将重试未完成项目。'),
  });
  stickerServices.push(stickerService);
  subscriptions.push(startStickerSyncTimer(stickerService, () => currentStatus === 'online', () => {}));
  adapterStatuses.set(accountConfig.uin, currentStatus);
  panelAccounts.push({
    adapter,
    getStatus: () => currentStatus,
    getNickname: () => adapter.nickname || String(adapter.account),
    getConnectionHint: () => adapter.getConnectionHint(),
  });
  const management = createManagementCommands({
    getConfig: () => configWatcher.getConfig(),
    repository,
    adapter,
    getAdapters: () => adapters,
    getNickname: () => adapter.nickname || String(adapter.account),
    onError: (error, message) => {
      logger.error(`管理指令消息 ${message.messageId} 执行失败：${describeError(error)}`);
    },
    collectSticker: (message) => stickerService.collect(message),
  });
  managementControllers.push(management);
  const pipeline = createMessagePipeline({
    getConfig: () => configWatcher.getConfig(),
    getPromptTemplates: () => promptTemplateStore.get(),
    repository,
    adapter,
    getNickname: () => adapter.nickname || String(adapter.account),
    isMuted: management.isMuted,
    moodService,
    affinityService,
    impressionsService,
    privateFactsService,
    privateMentionService,
    personaMemoryService,
    privacyGateService,
    stickerService,
    sleepWakeState,
    onError: (error, message) => {
      logger.error(`消息 ${message.messageId} 的辅助操作失败：${describeError(error)}`);
    },
  });
  pipelines.set(accountConfig.uin, pipeline);
  const catchUpHistory = createHistoryCatchUp({
    adapter,
    getConfig: () => configWatcher.getConfig(),
    repository,
    processMessage: (message, processOptions) => pipeline(message, processOptions),
    enqueue: (key, task) => sessionQueue.run(key, task),
    onError: (error, session) => {
      const context = session ? `会话 ${sessionId(session)}` : '联系人列表';
      logger.error(`账号 ${adapter.account} 的离线补课（${context}）失败：${describeError(error)}`);
    },
  });
  const runOnlineStartupTasks = createOnlineStartupTasks({
    catchUpHistory: async () => {
      try {
        return await catchUpHistory();
      } catch (error) {
        logger.error(`账号 ${adapter.account} 的离线补课启动失败：${describeError(error)}`);
        return false;
      }
    },
    syncStickers: async () => {
      try {
        await stickerService.sync();
      } catch (error) {
        logger.error(`账号 ${adapter.account} 的表情库同步失败：${describeError(error)}`);
      }
    },
    onError: (error) => {
      logger.error(`账号 ${adapter.account} 的上线启动任务失败：${describeError(error)}`);
    },
  });
  subscriptions.push(() => runOnlineStartupTasks.close());
  subscriptions.push(adapter.onStatus((status) => {
    currentStatus = status;
    adapterStatuses.set(accountConfig.uin, status);
    logger.info(`账号 ${adapter.account} 状态：${status}`);
    if (status === 'online') {
      void runOnlineStartupTasks().catch((error: unknown) => {
        logger.error(`账号 ${adapter.account} 的上线启动任务失败：${describeError(error)}`);
      });
    }
  }));
  const activityRouter = createAccountActivityRouter({
    now: Date.now,
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (timer) => clearTimeout(timer),
    queue: sessionQueue,
    getConfig: () => configWatcher.getConfig(),
    management,
    isBotAccount: (targetAccount, userId) => repository.getAccountKind(targetAccount, userId)?.kind === 'bot',
    costToday: () => repository.costToday(),
    processMessage: (message, processOptions) => pipeline(message, processOptions),
    onError: (error, message) => {
      logger.error(`消息 ${message.messageId} 处理失败：${describeError(error)}`);
    },
  });
  subscriptions.push(() => activityRouter.close());
  subscriptions.push(adapter.onMessage(activityRouter.route));

  const managed = managedHost !== undefined;
  const ready = managed && (injectedUins.has(accountConfig.uin) || managedHost?.status() === 'online');
  startAdapterForHost(adapter, { managed, ready });
  logger.info(managed && !ready
    ? `账号 ${accountConfig.uin} 等待小号登录。`
    : `正在连接账号 ${accountConfig.uin} ...`);
});

await startPanelWhileAccountStartupRuns(accountStartup, () => {
  if (!shuttingDown) {
    const panelConfig = configWatcher.getConfig();
    const panelPassword = process.env[panelConfig.panel.passwordEnv];
    if (!panelPassword) {
      logger.warn('未设置控制台密码，跳过管理面板启动；Aquarium 机器人继续运行。');
    } else {
      try {
        panelServer = startPanelServer({
          host: panelConfig.panel.host,
          port: panelConfig.panel.port,
          password: panelPassword,
          getConfig: () => configWatcher.getConfig(),
          getEnergySource: energySourceForAccount,
          saveConfig: (config) => {
            writeConfig(config, configPath);
            configWatcher.replaceConfig(config);
          },
          repository,
          accounts: () => panelAccounts,
          stickerServices: () => stickerServices,
          historyImports,
          impressionsService,
          tagClassificationService,
          profileActivity: profileActivityService,
          tagSubjects,
          memberSummaryRepository,
          sleepWakeState,
          cliRuntime,
          management: () => managementControllers,
          replayMessage: (message) => {
            const pipeline = pipelines.get(message.session.account);
            if (!pipeline) return Promise.resolve(undefined);
            return sessionQueue.run(sessionId(message.session), () => pipeline(message, { replay: true }));
          },
          root: process.cwd(),
          onError: (error, context) => {
            const location = context?.method && context.path
              ? `${context.method} ${context.path}`
              : context?.stage ?? '面板请求处理';
            logger.error(`管理面板请求失败（${location}）：${describeError(error, context?.stage ?? location)}`);
          },
        });
        panelServer.once('listening', () => {
          logger.info(`管理面板已启动：${panelConfig.panel.host}:${panelConfig.panel.port}`);
        });
        panelServer.on('error', (error: unknown) => {
          logger.error(`管理面板监听失败；机器人继续运行：${describeError(error)}`);
        });
      } catch (error) {
        logger.error(`管理面板启动失败；机器人继续运行：${describeError(error)}`);
      }
    }
    logger.info('Aquarium 已启动。Ctrl+C 可安全退出。');
  }
});
