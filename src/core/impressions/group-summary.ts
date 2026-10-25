import type { AquariumConfig } from '../../config/schema.ts';
import { canCallWithDailyBudget, isBudgetExceededError } from '../../llm/budget.ts';
import { callSlot } from '../../llm/slots.ts';
import type { PipelineModelCall } from '../conversation/steps/types.ts';
import type { MemberSummaryPromptTemplate } from '../prompt/templates/member-summary.ts';
import type { StoredTag } from '../../store/affect-repo.ts';
import type { GroupSummaryWrite } from '../../store/group-summary-repo.ts';
import type { StoreRepository } from '../../store/repository.ts';
import { isTagCategoryForScope } from './tag-model.ts';
import { redactSensitiveText } from './sensitive-text.ts';

const SUMMARY_TAG_CHANGE_TRIGGER = 3;
const SUMMARY_TAG_TEXT_LIMIT = 600;
const GROUP_TAG_ORDER = ['schedule', 'positioning', 'topic', 'atmosphere', 'meme', 'norms', 'recent'] as const;
const GROUP_TAG_LABELS: Record<(typeof GROUP_TAG_ORDER)[number], string> = {
  schedule: '作息',
  positioning: '定位',
  topic: '话题',
  atmosphere: '氛围',
  meme: '群梗',
  norms: '规矩',
  recent: '近况',
};

export interface GroupSummaryServiceOptions {
  repository: StoreRepository;
  getConfig: () => AquariumConfig;
  getTemplate: () => MemberSummaryPromptTemplate;
  callModel?: PipelineModelCall;
  now?: () => number;
  onError?: (error: unknown) => void;
}

export interface GroupSummaryService {
  maybeGenerate(account: number, sessionId: string, at: number): void;
  idle(): Promise<void>;
}

function formatGroupSummaryTags(tags: readonly StoredTag[]): string {
  const ordered = tags.filter((tag) => tag.status === 'confirmed'
    && !tag.locked
    && isTagCategoryForScope(tag.category, 'group')
    && tag.category !== 'misc')
    .slice()
    .sort((left, right) => GROUP_TAG_ORDER.indexOf(left.category as (typeof GROUP_TAG_ORDER)[number])
      - GROUP_TAG_ORDER.indexOf(right.category as (typeof GROUP_TAG_ORDER)[number])
      || (left.source === right.source ? 0 : left.source === 'manual' ? -1 : 1)
      || right.samples - left.samples
      || right.lastSeen - left.lastSeen);
  const groups = GROUP_TAG_ORDER.flatMap((category) => {
    const values = ordered.filter((tag) => tag.category === category).map((tag) => {
      const tagText = redactSensitiveText(tag.text);
      const subject = tag.subject ? redactSensitiveText(tag.subject) : '';
      const text = category === 'topic' && subject
        ? `${subject.replaceAll('/', ' › ')} › ${tagText}`
        : tagText;
      return category === 'meme' && !(text.startsWith('「') && text.endsWith('」')) ? `「${text}」` : text;
    });
    return values.length > 0 ? [`${GROUP_TAG_LABELS[category]}：${[...new Set(values)].join('、')}`] : [];
  });
  let result = '';
  for (const group of groups) {
    const candidate = result ? `${result}；${group}` : group;
    if (Array.from(candidate).length > SUMMARY_TAG_TEXT_LIMIT) break;
    result = candidate;
  }
  return result;
}

function validGeneratedText(value: string): string | undefined {
  const text = redactSensitiveText(value.trim());
  if (!text || /[\r\n]/u.test(text) || Array.from(text).length > 50) return undefined;
  return text;
}

export function createGroupSummaryService(options: GroupSummaryServiceOptions): GroupSummaryService {
  const now = options.now ?? Date.now;
  const callModel = options.callModel ?? callSlot;
  const pending = new Set<Promise<void>>();
  const running = new Set<string>();

  function reportError(error: unknown): void {
    if (isBudgetExceededError(error)) return;
    try {
      options.onError?.(error);
    } catch {
      // 群摘要生成失败不能影响 Aquarium 主流程。
    }
  }

  function maybeGenerate(account: number, sessionId: string, at: number): void {
    if (!Number.isSafeInteger(account) || account <= 0
      || typeof sessionId !== 'string' || !sessionId.startsWith(`${account}:group:`)
      || !Number.isSafeInteger(at) || at < 0) return;
    const key = `${account}:${sessionId}`;
    if (running.has(key)) return;

    try {
      const previous = options.repository.getGroupSummary(account, sessionId);
      if (previous?.manual) return;
      const tags = options.repository.listTagsForSubject(account, sessionId, null)
        .filter((tag) => tag.status === 'confirmed'
          && !tag.locked
          && isTagCategoryForScope(tag.category, 'group')
          && tag.category !== 'misc');
      const changedCount = previous
        ? tags.filter((tag) => tag.updatedAt > previous.updatedAt).length
        : tags.length;
      if (changedCount < SUMMARY_TAG_CHANGE_TRIGGER) return;

      const tagText = formatGroupSummaryTags(tags);
      const config = options.getConfig();
      if (!tagText || !canCallWithDailyBudget(config, 'extract', options.repository.costToday())) return;
      const template = options.getTemplate();
      const expectedUpdatedAt = previous?.updatedAt;
      running.add(key);
      let task: Promise<void>;
      task = Promise.resolve().then(async () => {
        const current = options.repository.getGroupSummary(account, sessionId);
        if (current?.manual || current?.updatedAt !== expectedUpdatedAt) return;
        const user = template.user
          .replaceAll('{{subject}}', '群')
          .replaceAll('{{tags}}', tagText);
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
          reportError(new Error('群印象摘要响应不是 1 到 50 字的单行文本'));
          return;
        }
        const write: GroupSummaryWrite = { account, sessionId, text, updatedAt: at };
        options.repository.saveGeneratedGroupSummary(write);
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
    async idle() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}
