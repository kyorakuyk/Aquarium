import type { AquariumConfig } from '../config/schema.ts';
import { createHistoryImportService } from '../core/impressions/history-import.ts';
import { createTagClassificationService } from '../core/impressions/classify-tags.ts';
import { createMemberSummaryService } from '../core/impressions/member-summary.ts';
import { createGroupSummaryService } from '../core/impressions/group-summary.ts';
import { createImpressionsService } from '../core/impressions/service.ts';
import type { PipelineModelCall } from '../core/conversation/steps/types.ts';
import { createPrivateFactsService } from '../core/privacy/service.ts';
import { createPrivacyGateService } from '../core/privacy/group-gate.ts';
import { createPrivacyMentionService } from '../core/privacy/mentions.ts';
import { promptTemplateStore } from '../core/prompt/templates.ts';
import type { StoreRepository } from '../store/repository.ts';
import type { TagSubjectRepository } from '../store/tag-subject-repo.ts';
import type { TagClassificationRepository } from '../store/tag-classification-repo.ts';
import type { MemberSummaryRepository } from '../store/member-summary-repo.ts';

interface ServiceLogger {
  error(message: string): void;
  info(message: string): void;
  warn(message: string): void;
}

export function createMemoryServices(options: {
  repository: StoreRepository;
  memberSummaryRepository: MemberSummaryRepository;
  tagSubjects: TagSubjectRepository;
  tagClassificationRepository: TagClassificationRepository;
  getConfig: () => AquariumConfig;
  logger: ServiceLogger;
  describeError: (error: unknown) => string;
  callModel?: PipelineModelCall;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const memberSummaryService = createMemberSummaryService({
    repository: options.repository,
    summaryRepository: options.memberSummaryRepository,
    getConfig: options.getConfig,
    getTemplate: () => promptTemplateStore.get().memberSummary,
    ...(options.callModel ? { callModel: options.callModel } : {}),
    now,
    onError: (error) => options.logger.error(`一句话印象生成失败：${options.describeError(error)}`),
  });
  const groupSummaryService = createGroupSummaryService({
    repository: options.repository,
    getConfig: options.getConfig,
    getTemplate: () => promptTemplateStore.get().memberSummary,
    ...(options.callModel ? { callModel: options.callModel } : {}),
    now,
    onError: (error) => options.logger.error(`群级一句话印象生成失败：${options.describeError(error)}`),
  });
  const impressionsService = createImpressionsService({
    repository: options.repository,
    tagSubjects: options.tagSubjects,
    getConfig: options.getConfig,
    ...(options.callModel ? { callModel: options.callModel } : {}),
    now,
    onError: (error) => options.logger.error(`印象提取失败：${options.describeError(error)}`),
    onWarn: (message) => options.logger.warn(message),
    onMemberSummaryCheck: memberSummaryService.maybeGenerate,
    onExtract: (summary) => {
      const dropReasons = Object.entries(summary.droppedTagReasons)
        .filter(([, count]) => count > 0)
        .map(([reason, count]) => `${reason}:${count}`)
        .join(',');
      options.logger.info(
        `印象提取 ${summary.sessionId}：${summary.status}，新增 ${summary.inserted}、观察 ${summary.observed}、推翻 ${summary.superseded}、丢弃 ${summary.dropped}${dropReasons ? `（${dropReasons}）` : ''}。`,
      );
      if (summary.status === 'done') groupSummaryService.maybeGenerate(summary.account, summary.sessionId, now());
    },
  });
  const tagClassificationService = createTagClassificationService({
    repository: options.repository,
    classificationRepository: options.tagClassificationRepository,
    getConfig: options.getConfig,
    getTemplate: () => promptTemplateStore.get().classifyTags,
    onError: (error) => options.logger.error(`旧标签整理失败：${options.describeError(error)}`),
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
  const privacyGateService = createPrivacyGateService({
    repository: options.repository,
    getConfig: options.getConfig,
    onError: ({ account, sessionId }) => {
      options.logger.error(`群聊隐私守门失败：账号 ${account} 会话 ${sessionId}`);
    },
    onEgress: ({ account, sessionId, factId }) => {
      options.logger.warn(`群聊隐私出口拦截：账号 ${account} 会话 ${sessionId} 条目 ${factId}`);
    },
  });
  const privateMentionService = createPrivacyMentionService({
    repository: options.repository,
    getConfig: options.getConfig,
    onError: ({ account, sessionId }) => {
      options.logger.error(`群聊私聊事实提及判断失败：账号 ${account} 会话 ${sessionId}`);
    },
    onMention: ({ account, sessionId, factId, mentions, level }) => {
      options.logger.info(`私聊事实提及：账号 ${account} 会话 ${sessionId} 条目 ${factId} 次数 ${mentions} 等级 ${level}`);
    },
  });
  const historyImports = createHistoryImportService({
    repository: options.repository,
    getConfig: options.getConfig,
    impressionsService,
    getTemplate: () => promptTemplateStore.get().extractTags,
  });
  return {
    impressionsService,
    memberSummaryService,
    groupSummaryService,
    tagClassificationService,
    privateFactsService,
    privateMentionService,
    privacyGateService,
    historyImports,
  };
}
