import type { AquariumConfig } from '../config/schema.ts';
import { createHistoryImportService } from '../core/impressions/history-import.ts';
import { createImpressionsService } from '../core/impressions/service.ts';
import { createPrivateFactsService } from '../core/privacy/service.ts';
import { promptTemplateStore } from '../core/prompt-templates.ts';
import type { StoreRepository } from '../store/repository.ts';

interface ServiceLogger {
  error(message: string): void;
  info(message: string): void;
}

export function createMemoryServices(options: {
  repository: StoreRepository;
  getConfig: () => AquariumConfig;
  logger: ServiceLogger;
  describeError: (error: unknown) => string;
}) {
  const impressionsService = createImpressionsService({
    repository: options.repository,
    getConfig: options.getConfig,
    onError: (error) => options.logger.error(`印象提取失败：${options.describeError(error)}`),
    onExtract: (summary) => {
      options.logger.info(
        `印象提取 ${summary.sessionId}：${summary.status}，新增 ${summary.inserted}、观察 ${summary.observed}、推翻 ${summary.superseded}、丢弃 ${summary.dropped}。`,
      );
    },
  });
  const privateFactsService = createPrivateFactsService({
    repository: options.repository,
    getConfig: options.getConfig,
    onError: ({ account, sessionId }) => {
      options.logger.error(`私聊记忆提取失败：账号 ${account} 会话 ${sessionId}`);
    },
    onExtract: (summary) => {
      options.logger.info(
        `私聊记忆提取 ${summary.sessionId}：${summary.status}，新增 ${summary.inserted}、更新 ${summary.updated}、过时 ${summary.deleted}、丢弃 ${summary.dropped}。`,
      );
    },
  });
  const historyImports = createHistoryImportService({
    repository: options.repository,
    getConfig: options.getConfig,
    impressionsService,
    getTemplate: () => promptTemplateStore.get().extractTags,
  });
  return { impressionsService, privateFactsService, historyImports };
}
