import { OneBotAdapter } from '../adapters/onebot/adapter.ts';
import { loadConfig } from '../config/load.ts';
import { watchConfig } from '../config/watch.ts';
import { createLogger } from '../core/logger.ts';
import { createMessagePipeline } from '../core/pipeline.ts';
import { createHistoryCatchUp } from '../core/history-catchup.ts';
import { createManagementCommands } from '../core/management.ts';
import { sessionId } from '../core/events.ts';
import { createSessionQueue } from '../core/session-queue.ts';
import { openDatabase } from '../store/db.ts';
import { createRepository } from '../store/repository.ts';

const logger = createLogger('app');
const initialConfig = loadConfig();
const database = openDatabase();
const repository = createRepository(database);
const configWatcher = watchConfig({ initialConfig });
function pruneDebugTraces(): void {
  try {
    const config = configWatcher.getConfig();
    const deleted = repository.pruneDebugTraces(Date.now(), config.debug.retainDays);
    if (deleted > 0) logger.info(`已清理过期调试记录：${deleted} 条。`);
  } catch (error) {
    logger.error(`清理过期调试记录失败：${describeError(error)}`);
  }
}
pruneDebugTraces();
const debugPruneTimer = setInterval(pruneDebugTraces, 6 * 60 * 60 * 1000);
debugPruneTimer.unref();
const adapters: OneBotAdapter[] = [];
const subscriptions: Array<() => void> = [];
const sessionQueue = createSessionQueue();
let shuttingDown = false;

function hasEnabledSession(config: typeof initialConfig): boolean {
  return config.defaults.enabled || Object.values(config.sessions).some((session) => session.enabled === true);
}

function describeError(error: unknown): string {
  if (!error || typeof error !== 'object') return '未知错误';
  const details = error as { name?: unknown; status?: unknown; code?: unknown };
  return [
    typeof details.name === 'string' ? details.name : 'Error',
    ...(typeof details.status === 'number' ? [`status=${details.status}`] : []),
    ...(typeof details.code === 'string' ? [`code=${details.code}`] : []),
  ].join(' ');
}

function accountSignature(config: typeof initialConfig): string {
  return JSON.stringify(config.accounts.map(({ uin, snowlumaDir }) => [uin, snowlumaDir]));
}

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`收到 ${signal}，正在关闭 Aquarium。`);
  for (const unsubscribe of subscriptions) unsubscribe();
  for (const adapter of adapters) adapter.close();
  configWatcher.close();
  clearInterval(debugPruneTimer);
  await sessionQueue.idle();
  database.close();
  logger.info('Aquarium 已关闭。');
}

process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });

configWatcher.on('changed', (config) => {
  logger.info('配置已热重载；后续收到的消息将使用新配置。');
  if (!hasEnabledSession(config)) logger.warn('当前没有启用任何会话。');
  if (accountSignature(config) !== accountSignature(initialConfig)) {
    logger.warn('账号列表或 SnowLuma 路径已变化；现有连接不会自动重建，请重启 Aquarium。');
  }
});

if (!hasEnabledSession(initialConfig)) logger.warn('当前没有启用任何会话。');
if (initialConfig.accounts.length === 0) logger.warn('配置中没有账号，当前不会连接 OneBot。');

for (const accountConfig of initialConfig.accounts) {
  let adapter: OneBotAdapter;
  try {
    adapter = new OneBotAdapter({
      account: accountConfig.uin,
      snowlumaDir: accountConfig.snowlumaDir,
    });
  } catch (error) {
    logger.error(`账号 ${accountConfig.uin} 的 OneBot 适配器初始化失败：${describeError(error)}`);
    continue;
  }

  adapters.push(adapter);
  const management = createManagementCommands({
    getConfig: () => configWatcher.getConfig(),
    repository,
    adapter,
    getAdapters: () => adapters,
    getNickname: () => adapter.nickname || String(adapter.account),
    onError: (error, message) => {
      logger.error(`管理指令消息 ${message.messageId} 执行失败：${describeError(error)}`);
    },
  });
  const pipeline = createMessagePipeline({
    getConfig: () => configWatcher.getConfig(),
    repository,
    adapter,
    getNickname: () => adapter.nickname || String(adapter.account),
    isMuted: management.isMuted,
    onError: (error, message) => {
      logger.error(`消息 ${message.messageId} 的辅助操作失败：${describeError(error)}`);
    },
  });
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
  subscriptions.push(adapter.onStatus((status) => {
    logger.info(`账号 ${adapter.account} 状态：${status}`);
    if (status === 'online') {
      void catchUpHistory().catch((error: unknown) => {
        logger.error(`账号 ${adapter.account} 的离线补课启动失败：${describeError(error)}`);
      });
    }
  }));
  subscriptions.push(adapter.onMessage((message) => {
    void sessionQueue.run(sessionId(message.session), async () => {
      if (await management.handle(message)) return;
      await pipeline(message);
    })
      .catch((error: unknown) => {
        logger.error(`消息 ${message.messageId} 处理失败：${describeError(error)}`);
      });
  }));

  try {
    logger.info(`正在连接账号 ${accountConfig.uin} ...`);
    await adapter.connect();
  } catch (error) {
    logger.error(`账号 ${accountConfig.uin} 连接失败：${describeError(error)}`);
  }
}

logger.info('Aquarium 已启动。Ctrl+C 可安全退出。');
