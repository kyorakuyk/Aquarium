import type { AquariumConfig } from '../../config/schema.ts';
import { budgetState } from '../../llm/budget.ts';
import { callSlot } from '../../llm/slots.ts';
import type { MemberSummaryPromptTemplate } from '../prompt/templates/member-summary.ts';
import type { PipelineModelCall } from '../conversation/steps/types.ts';
import type { MemberSummaryRecord, MemberSummaryRepository, MemberSummaryWrite } from '../../store/member-summary-repo.ts';
import type { StoreRepository } from '../../store/repository.ts';
import { formatMemberTags } from './member-tags.ts';

const SUMMARY_TAG_CHANGE_TRIGGER = 3;

export interface MemberSummaryServiceOptions {
  repository: Pick<StoreRepository, 'listGroupTagsForUser' | 'costToday' | 'recordUsage'>;
  summaryRepository: MemberSummaryRepository;
  getConfig: () => AquariumConfig;
  getTemplate: () => MemberSummaryPromptTemplate;
  callModel?: PipelineModelCall;
  now?: () => number;
  onError?: (error: unknown) => void;
}

export interface MemberSummaryService {
  maybeGenerate(account: number, userId: number, at: number): void;
  get(account: number, userId: number): MemberSummaryRecord | undefined;
  saveManual(input: MemberSummaryWrite): void;
  idle(): Promise<void>;
}

function validGeneratedText(value: string): string | undefined {
  const text = value.trim();
  if (!text || /[\r\n]/u.test(text) || Array.from(text).length > 50) return undefined;
  return text;
}

export function createMemberSummaryService(options: MemberSummaryServiceOptions): MemberSummaryService {
  const now = options.now ?? Date.now;
  const callModel = options.callModel ?? callSlot;
  const pending = new Set<Promise<void>>();
  const running = new Set<string>();

  function reportError(error: unknown): void {
    try {
      options.onError?.(error);
    } catch {
      // 摘要生成失败不能影响 Aquarium 主流程。
    }
  }

  function maybeGenerate(account: number, userId: number, at: number): void {
    if (!Number.isSafeInteger(account) || account <= 0
      || !Number.isSafeInteger(userId) || userId <= 0
      || !Number.isSafeInteger(at) || at < 0) return;
    const key = `${account}:${userId}`;
    if (running.has(key)) return;

    try {
      const previous = options.summaryRepository.get(account, userId);
      if (previous?.manual) return;
      const tags = options.repository.listGroupTagsForUser(account, userId)
        .filter((tag) => tag.status === 'confirmed'
          && !tag.locked
          && tag.category !== 'misc'
          && tag.category !== 'atmosphere');
      const changedCount = previous
        ? tags.filter((tag) => tag.updatedAt > previous.updatedAt).length
        : tags.length;
      if (changedCount < SUMMARY_TAG_CHANGE_TRIGGER) return;

      const tagText = formatMemberTags(tags);
      const config = options.getConfig();
      if (!tagText || budgetState(config, options.repository.costToday()) === 'exceeded') return;
      const template = options.getTemplate();
      const expectedUpdatedAt = previous?.updatedAt;
      running.add(key);
      let task: Promise<void>;
      task = Promise.resolve().then(async () => {
        const current = options.summaryRepository.get(account, userId);
        if (current?.manual || current?.updatedAt !== expectedUpdatedAt) return;
        const user = template.user.replaceAll('{{tags}}', tagText);
        const response = await callModel('extract', [
          { role: 'system', content: template.system },
          { role: 'user', content: user },
        ], {
          config,
          account,
          costToday: () => options.repository.costToday(),
          recordUsage: (usage) => options.repository.recordUsage({ ...usage, account }),
          now,
        });
        const text = validGeneratedText(response.text);
        if (!text) {
          reportError(new Error('成员印象摘要响应不是 1 到 50 字的单行文本'));
          return;
        }
        options.summaryRepository.saveGenerated({ account, userId, text, updatedAt: at });
      }).catch(reportError).finally(() => {
        running.delete(key);
        pending.delete(task);
      });
      pending.add(task);
    } catch (error) {
      reportError(error);
    }
  }

  return {
    maybeGenerate,
    get: (account, userId) => options.summaryRepository.get(account, userId),
    saveManual: (input) => options.summaryRepository.saveManual(input),
    async idle() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}
