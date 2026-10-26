import type { AquariumConfig } from '../config/schema.ts';
import { resolveSession } from '../config/resolve.ts';
import { sleepPlan, type SleepWakeState } from '../core/sleep/index.ts';
import type { ImpressionsService } from '../core/impressions/service.ts';
import type { PrivateMentionService } from '../core/privacy/mentions.ts';
import type { PrivateFactsService } from '../core/privacy/service.ts';
import { createPersonaMemoryService, type PersonaMemoryService } from '../core/persona-memory.ts';
import { createPersonaMemoryScheduler } from '../core/memory/scheduler.ts';
import type { PromptTemplateSet } from '../core/prompt/templates.ts';
import type { StoreRepository } from '../store/repository.ts';
import type { PipelineResult, ProcessMessageOptions } from '../core/conversation/steps/types.ts';
import type { IncomingMessage } from '../core/shared/events.ts';
import { createPersonaMemoryDiaryGenerator } from './persona-memory-diary.ts';
import { createPersonaMemorySegmentProcessor, createQueuedPersonaMemoryProcessor } from './persona-memory-processor.ts';
import { processPersonaMemoryWakeFollowups } from './persona-memory-wake.ts';
import { processPersonaMemoryWakeWordJobs } from './persona-memory-wakeword.ts';

const DAY_MS = 24 * 60 * 60_000;

export interface PersonaMemoryRuntime {
  service: PersonaMemoryService;
  onSleep(cycleKey: string, now: number): Promise<void>;
  onWake(cycleKey: string, now: number, bedAt: number, wakeAt: number): Promise<void>;
  start(): () => void;
  idle(): Promise<void>;
}

export function createPersonaMemoryRuntime(options: {
  repository: StoreRepository;
  getConfig: () => AquariumConfig;
  getTemplates: () => PromptTemplateSet;
  impressionsService: ImpressionsService;
  privateFactsService: PrivateFactsService;
  privateMentionService: PrivateMentionService;
  dispatchWakeFollowup: (message: IncomingMessage, options: ProcessMessageOptions) => Promise<PipelineResult>;
  sleepWakeState?: SleepWakeState;
  now?: () => number;
  onInfo?: (message: string) => void;
  onWarning?: (message: string) => void;
  onError?: (message: string) => void;
}): PersonaMemoryRuntime {
  const report = (callback: ((message: string) => void) | undefined, message: string): void => {
    try { callback?.(message); } catch { /* 日志回调不能影响记忆调度。 */ }
  };
  const segmentProcessor = createPersonaMemorySegmentProcessor({
    repository: options.repository,
    impressionsService: options.impressionsService,
    privateFactsService: options.privateFactsService,
    privateMentionService: options.privateMentionService,
    getConfig: options.getConfig,
    getTemplates: options.getTemplates,
  });
  const processSession = createQueuedPersonaMemoryProcessor({
    isSessionEnabled: (session) => resolveSession(options.getConfig(), session).enabled,
    process: segmentProcessor.process,
  });
  const generateDiary = createPersonaMemoryDiaryGenerator({
    getConfig: options.getConfig,
    repository: options.repository,
  });
  const service = createPersonaMemoryService({
    repository: options.repository,
    getConfig: options.getConfig,
    canProcessSession: (session) => resolveSession(options.getConfig(), session).enabled,
    processSession,
    isSignificantSegment: segmentProcessor.isSignificantSegment,
    generateDiary,
    onError: () => report(options.onError, '夜间人格记忆整理内部任务失败；未完成来源保留待处理。'),
  });
  const tasks = new Set<Promise<void>>();
  let cycleQueue = Promise.resolve();
  let followupsRunning = false;
  let wakePreparations = 0;
  let recoveredSending = false;

  function track(task: Promise<void>): Promise<void> {
    tasks.add(task);
    void task.then(() => tasks.delete(task), () => tasks.delete(task));
    return task;
  }

  function queueCycle(taskBody: () => Promise<void>): Promise<void> {
    const task = cycleQueue.then(taskBody);
    cycleQueue = task.catch(() => undefined);
    return track(task);
  }

  async function cleanupRawMessages(account: number, now: number): Promise<void> {
    try {
      const contexts = options.repository.deleteExpiredPersonaMemorySleepContexts(account, now);
      const followups = options.repository.expirePersonaMemoryWakeFollowups(account, now);
      if (contexts > 0 || followups > 0) {
        report(options.onInfo, `账号 ${account} 已清理过期睡眠上下文 ${contexts} 个、补回复 ${followups} 条。`);
      }
    } catch {
      report(options.onError, `账号 ${account} 睡眠上下文清理失败。`);
    }
    try {
      const retentionDays = options.getConfig().memory.rawRetentionDays;
      const cutoff = Math.max(0, now - retentionDays * DAY_MS);
      const deleted = options.repository.deleteOrganizedPersonaMemoryMessagesBefore(account, cutoff);
      if (deleted > 0) report(options.onInfo, `账号 ${account} 已清理 ${deleted} 条过期且已整理的原文缓存。`);
    } catch {
      report(options.onError, `账号 ${account} 原文缓存清理失败。`);
    }
  }

  async function runCycle(cycleKey: string, now: number): Promise<void> {
    return queueCycle(async () => {
      for (const account of options.getConfig().accounts) {
        try {
          const result = await service.organizeAtSleep({ account: account.uin, cycleKey, now });
          if (result.status === 'budget') report(options.onWarning, `账号 ${account.uin} 夜间整理因预算超限跳过。`);
          else if (result.status === 'partial') report(options.onWarning, `账号 ${account.uin} 本轮夜间整理未完成，剩余来源保留待下次整理。`);
          else if (result.status === 'failed') report(options.onError, `账号 ${account.uin} 夜间整理失败；待处理来源保留。`);
        } catch {
          report(options.onError, `账号 ${account.uin} 夜间整理失败；待处理来源保留。`);
        }
        await cleanupRawMessages(account.uin, now);
      }
    });
  }

  function runWakeCycle(cycleKey: string, now: number, bedAt: number, wakeAt: number): Promise<void> {
    wakePreparations += 1;
    const task = (async () => {
      try {
        await queueCycle(async () => {
          for (const account of options.getConfig().accounts) {
            try {
              const result = await service.organizeAtWake({ account: account.uin, cycleKey, now, bedAt, wakeAt });
              if (result.organized.status === 'budget') {
                report(options.onWarning, `账号 ${account.uin} 醒来整理因预算超限跳过。`);
              } else if (result.organized.status === 'partial') {
                report(options.onWarning, `账号 ${account.uin} 醒来整理未完成，剩余来源保留待处理。`);
              } else if (result.organized.status === 'failed') {
                report(options.onError, `账号 ${account.uin} 醒来整理失败；待处理来源保留。`);
              }
              if (result.contextCount > 0 || result.followupCount > 0) {
                report(options.onInfo, `账号 ${account.uin} 醒来整理完成：上下文 ${result.contextCount} 个会话，补回复 ${result.followupCount} 个会话。`);
              }
            } catch {
              report(options.onError, `账号 ${account.uin} 醒来整理失败；待处理来源保留。`);
            }
            await cleanupRawMessages(account.uin, now);
          }
        });
      } finally {
        wakePreparations -= 1;
      }
      await dispatchPendingFollowups(now);
    })();
    return track(task);
  }

  async function dispatchPendingFollowups(now: number): Promise<void> {
    if (followupsRunning || wakePreparations > 0) return;
    const config = options.getConfig();
    const sleepScheduled = config.sleep.enabled && sleepPlan(now, config.sleep.bedtime, config.sleep.wake).asleep;
    const awake = !sleepScheduled || (options.sleepWakeState?.isAwake(now) ?? false);
    followupsRunning = true;
    const task = (async () => {
      for (const account of options.getConfig().accounts) {
        try {
          const wakeWordResult = await processPersonaMemoryWakeWordJobs({
            repository: options.repository,
            service,
            account: account.uin,
            now,
            awake,
          });
          if (wakeWordResult.scheduled > 0) {
            report(options.onInfo, `账号 ${account.uin} 的唤醒词积压已整理并进入受控补回复队列 ${wakeWordResult.scheduled} 条。`);
          }
        } catch {
          report(options.onError, `账号 ${account.uin} 唤醒词积压任务处理失败。`);
        }
        if (sleepScheduled && !awake) continue;
        try {
          const result = await processPersonaMemoryWakeFollowups({
            repository: options.repository,
            account: account.uin,
            now,
            dispatch: options.dispatchWakeFollowup,
            onNeedsReview: (_session, reason) => report(
              options.onWarning,
              `账号 ${account.uin} 的补回复状态不确定（${reason}），未自动重试。`,
            ),
          });
          if (result.deferred > 0) report(options.onInfo, `账号 ${account.uin} 有 ${result.deferred} 条补回复等待频率或预算条件恢复。`);
        } catch {
          report(options.onError, `账号 ${account.uin} 补回复队列处理失败。`);
        }
      }
    })();
    tasks.add(task);
    try {
      await task;
    } finally {
      tasks.delete(task);
      followupsRunning = false;
    }
  }

  const scheduler = createPersonaMemoryScheduler({
    getConfig: options.getConfig,
    runCycle,
    onTick: dispatchPendingFollowups,
    now: options.now,
    onError: () => report(options.onError, '人格记忆调度器运行失败。'),
  });

  function start(): () => void {
    if (!recoveredSending) {
      recoveredSending = true;
      const now = options.now?.() ?? Date.now();
      for (const account of options.getConfig().accounts) {
        const recovered = options.repository.recoverPersonaMemoryWakeFollowups(account.uin, now);
        if (recovered > 0) report(
          options.onWarning,
          `账号 ${account.uin} 有 ${recovered} 条补回复在进程中断时发送状态不确定，未自动重试。`,
        );
        const recoveredWakeWordJobs = options.repository.recoverPersonaMemoryWakeWordJobs(account.uin, now);
        if (recoveredWakeWordJobs > 0) report(
          options.onWarning,
          `账号 ${account.uin} 有 ${recoveredWakeWordJobs} 条唤醒词积压任务已从中断状态恢复。`,
        );
      }
    }
    return scheduler.start();
  }

  return {
    service,
    onSleep: (cycleKey, now) => scheduler.onSleep(cycleKey, now),
    onWake: runWakeCycle,
    start,
    async idle() {
      while (tasks.size > 0) await Promise.all([...tasks].map((task) => task.catch(() => undefined)));
    },
  };
}
