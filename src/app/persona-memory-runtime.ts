import type { AquariumConfig } from '../config/schema.ts';
import { resolveSession } from '../config/resolve.ts';
import type { ImpressionsService } from '../core/impressions/service.ts';
import type { PrivateMentionService } from '../core/privacy/mentions.ts';
import type { PrivateFactsService } from '../core/privacy/service.ts';
import { createPersonaMemoryService, type PersonaMemoryService } from '../core/persona-memory.ts';
import { createPersonaMemoryScheduler } from '../core/memory/scheduler.ts';
import type { PromptTemplateSet } from '../core/prompt/templates.ts';
import type { StoreRepository } from '../store/repository.ts';
import { createPersonaMemoryDiaryGenerator } from './persona-memory-diary.ts';
import { createPersonaMemorySegmentProcessor, createQueuedPersonaMemoryProcessor } from './persona-memory-processor.ts';

const DAY_MS = 24 * 60 * 60_000;

export interface PersonaMemoryRuntime {
  service: PersonaMemoryService;
  onSleep(cycleKey: string, now: number): Promise<void>;
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

  async function runCycle(cycleKey: string, now: number): Promise<void> {
    const task = (async () => {
      for (const account of options.getConfig().accounts) {
        try {
          const result = await service.organizeAtSleep({ account: account.uin, cycleKey, now });
          if (result.status === 'budget') report(options.onWarning, `账号 ${account.uin} 夜间整理因预算超限跳过。`);
          else if (result.status === 'partial') report(options.onWarning, `账号 ${account.uin} 本轮夜间整理未完成，剩余来源保留待下次整理。`);
          else if (result.status === 'failed') report(options.onError, `账号 ${account.uin} 夜间整理失败；待处理来源保留。`);
        } catch {
          report(options.onError, `账号 ${account.uin} 夜间整理失败；待处理来源保留。`);
        }
        try {
          const retentionDays = options.getConfig().memory.rawRetentionDays;
          const cutoff = Math.max(0, now - retentionDays * DAY_MS);
          const deleted = options.repository.deleteOrganizedPersonaMemoryMessagesBefore(account.uin, cutoff);
          if (deleted > 0) report(options.onInfo, `账号 ${account.uin} 已清理 ${deleted} 条过期且已整理的原文缓存。`);
        } catch {
          report(options.onError, `账号 ${account.uin} 原文缓存清理失败。`);
        }
      }
    })();
    tasks.add(task);
    try {
      await task;
    } finally {
      tasks.delete(task);
    }
  }

  const scheduler = createPersonaMemoryScheduler({
    getConfig: options.getConfig,
    runCycle,
    onError: () => report(options.onError, '人格记忆调度器运行失败。'),
  });

  return {
    service,
    onSleep: (cycleKey, now) => scheduler.onSleep(cycleKey, now),
    start: () => scheduler.start(),
    async idle() {
      while (tasks.size > 0) await Promise.all([...tasks].map((task) => task.catch(() => undefined)));
    },
  };
}
