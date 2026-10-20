import type OpenAI from 'openai';
import type { AquariumConfig } from '../../config/schema.ts';
import { budgetState } from '../../llm/budget.ts';
import { callSlot } from '../../llm/slots.ts';
import type { PipelineModelCall } from '../conversation/steps/types.ts';
import type { ClassifyTagsPromptTemplate } from '../prompt/templates.ts';
import type { StoreRepository } from '../../store/repository.ts';
import type { StoredTag } from '../../store/tag-repo.ts';
import { isTagCategoryKey, isTagPolarity, normalizeTagSubject } from './tag-model.ts';
import type { TagCategoryKey, TagPolarity } from './tag-model.ts';
import type { TagClassificationProfile, TagClassificationRepository } from '../../store/tag-classification-repo.ts';

export const TAG_CLASSIFICATION_BATCH_SIZE = 50;

type ClassifiableTagCategory = Exclude<TagCategoryKey, 'schedule'>;

export interface ClassifyTagsItem {
  id: number;
  category: ClassifiableTagCategory;
  subject: string | null;
  polarity: TagPolarity;
  mergeInto: number | null;
}

export interface TagClassificationStatus {
  state: 'idle' | 'running' | 'completed' | 'budget' | 'incomplete' | 'error';
  total: number;
  processed: number;
  merged: number;
  lockedSkipped: number;
  remaining: number;
  startedAt: number | null;
  completedAt: number | null;
}

export interface TagClassificationServiceOptions {
  repository: StoreRepository;
  classificationRepository: TagClassificationRepository;
  getConfig: () => AquariumConfig;
  getTemplate: () => ClassifyTagsPromptTemplate;
  callModel?: PipelineModelCall;
  now?: () => number;
  onError?: (error: unknown) => void;
}

export interface TagClassificationService {
  startOnStartup(): void;
  startManual(): boolean;
  status(): TagClassificationStatus;
  idle(): Promise<void>;
}

export function buildClassifyTagsMessages(
  tags: readonly StoredTag[],
  scope: 'group' | 'member',
  template: ClassifyTagsPromptTemplate,
): OpenAI.ChatCompletionMessageParam[] {
  const visible = tags
    .filter((tag) => tag.category === 'misc' && !tag.locked && tag.status !== 'superseded')
    .slice(0, TAG_CLASSIFICATION_BATCH_SIZE)
    .map(({ id, text, norm, status }) => ({ id, text, norm, status }));
  const user = template.user
    .replaceAll('{{scope}}', scope)
    .replaceAll('{{tags}}', JSON.stringify(visible));
  return [
    { role: 'system', content: template.system },
    { role: 'user', content: user },
  ];
}

export function parseClassifyTagsResponse(text: string): ClassifyTagsItem[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const items = (parsed as Record<string, unknown>).items;
  if (!Array.isArray(items)) return undefined;
  const result: ClassifyTagsItem[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const record = raw as Record<string, unknown>;
    const category = record.category;
    const subject = record.subject;
    const polarity = record.polarity;
    const mergeInto = record.mergeInto;
    if (!Number.isSafeInteger(record.id) || (record.id as number) <= 0
      || !isTagCategoryKey(category) || category === 'schedule'
      || (subject !== null && typeof subject !== 'string')
      || (typeof subject === 'string' && !normalizeTagSubject(subject))
      || (polarity !== null && !isTagPolarity(polarity))
      || (category !== 'fandom' && (subject !== null || polarity !== null))
      || (mergeInto !== null && (!Number.isSafeInteger(mergeInto) || (mergeInto as number) <= 0))) {
      return undefined;
    }
    result.push({
      id: record.id as number,
      category: category as ClassifiableTagCategory,
      subject: subject as string | null,
      polarity: polarity as TagPolarity,
      mergeInto: mergeInto as number | null,
    });
  }
  return result;
}

const identityTextPattern = /^(?:[IE][NS][TF][JP]|(?:Ni|Ne|Si|Se|Ti|Te|Fi|Fe)(?: 主导| 辅助)?)$/u;

function profileForTag(item: ClassifyTagsItem, tag: StoredTag, scope: 'group' | 'member'): TagClassificationProfile | undefined {
  if (item.category === 'atmosphere' && scope !== 'group') return undefined;
  if (item.category === 'identity' && !identityTextPattern.test(tag.text)) return undefined;
  return {
    category: item.category,
    subject: item.subject,
    polarity: item.polarity,
  };
}

function sameOutputSet(items: ClassifyTagsItem[], tags: StoredTag[]): boolean {
  if (items.length !== tags.length) return false;
  const expected = new Set(tags.map((tag) => tag.id));
  const actual = new Set(items.map((item) => item.id));
  return expected.size === tags.length && actual.size === items.length
    && expected.size === actual.size && [...actual].every((id) => expected.has(id));
}

export function createTagClassificationService(options: TagClassificationServiceOptions): TagClassificationService {
  const now = options.now ?? Date.now;
  const callModel = options.callModel ?? callSlot;
  let current: TagClassificationStatus = {
    state: 'idle',
    total: 0,
    processed: 0,
    merged: 0,
    lockedSkipped: 0,
    remaining: 0,
    startedAt: null,
    completedAt: null,
  };
  let pending: Promise<void> | undefined;

  const remainingCount = () => options.classificationRepository.listUnlockedMiscTags().length;

  function updateStatus(patch: Partial<TagClassificationStatus>): void {
    current = { ...current, ...patch };
  }

  function reportError(error: unknown): void {
    try {
      options.onError?.(error);
    } catch {
      // 后台整理失败不能影响 Aquarium 主流程。
    }
  }

  function classifySingle(tagId: number, profile: TagClassificationProfile, at: number): boolean {
    const tag = options.repository.tagById(tagId);
    if (!tag || tag.category !== 'misc' || tag.locked || tag.status === 'superseded') return false;
    options.repository.updateTag(tag.id, {
      category: profile.category,
      subject: profile.subject,
      polarity: profile.polarity,
      ...(profile.category === 'identity' && tag.origin === 'inferred'
        && tag.source === 'auto' && tag.status === 'confirmed'
        ? { status: 'candidate' as const }
        : {}),
      updatedAt: at,
    });
    return true;
  }

  async function classifyRemaining(): Promise<void> {
    const initial = options.classificationRepository.listUnlockedMiscTags();
    updateStatus({
      state: 'running',
      total: initial.length,
      processed: 0,
      merged: 0,
      lockedSkipped: options.classificationRepository.countLockedMiscTags(),
      remaining: initial.length,
      startedAt: now(),
      completedAt: null,
    });

    const scopes = new Map<string, { scope: 'group' | 'member'; tags: StoredTag[] }>();
    for (const tag of initial) {
      const scope = tag.userId === null ? 'group' : 'member';
      const key = JSON.stringify([tag.account, tag.sessionId, tag.userId]);
      const group = scopes.get(key) ?? { scope, tags: [] };
      group.tags.push(tag);
      scopes.set(key, group);
    }

    for (const { scope, tags } of scopes.values()) {
      for (let offset = 0; offset < tags.length; offset += TAG_CLASSIFICATION_BATCH_SIZE) {
        const batch = tags.slice(offset, offset + TAG_CLASSIFICATION_BATCH_SIZE);
        const account = batch[0]?.account;
        if (account === undefined) continue;
        const config = options.getConfig();
        if (budgetState(config, options.repository.costToday()) === 'exceeded') {
          updateStatus({ state: 'budget', remaining: remainingCount() });
          return;
        }

        const response = await callModel('extract', buildClassifyTagsMessages(
          batch,
          scope,
          options.getTemplate(),
        ), {
          config,
          account,
          costToday: () => options.repository.costToday(),
          recordUsage: (usage) => options.repository.recordUsage({ ...usage, account }),
          now,
        });
        const items = parseClassifyTagsResponse(response.text);
        if (!items || !sameOutputSet(items, batch)) {
          updateStatus({ state: 'incomplete', remaining: remainingCount() });
          return;
        }
        const tagsById = new Map(batch.map((tag) => [tag.id, tag]));
        const profiles = new Map<number, TagClassificationProfile>();
        for (const item of items) {
          const tag = tagsById.get(item.id);
          const profile = tag ? profileForTag(item, tag, scope) : undefined;
          if (!profile) {
            updateStatus({ state: 'incomplete', remaining: remainingCount() });
            return;
          }
          profiles.set(item.id, profile);
        }

        const itemById = new Map(items.map((item) => [item.id, item]));
        const mergeSources: ClassifyTagsItem[] = [];
        for (const item of items) {
          const target = item.mergeInto === null ? undefined : itemById.get(item.mergeInto);
          const sourceTag = tagsById.get(item.id);
          const targetTag = target ? tagsById.get(target.id) : undefined;
          const mergeValid = target !== undefined && targetTag !== undefined && sourceTag !== undefined
            && item.id !== target.id && target.mergeInto === null
            && target.category === item.category && target.polarity === item.polarity
            && sourceTag.norm !== targetTag.norm
            && sourceTag.status !== 'rejected' && targetTag.status !== 'rejected';
          if (item.mergeInto !== null && mergeValid) mergeSources.push(item);
          else if (item.mergeInto !== null) {
            const profile = profiles.get(item.id);
            if (profile && classifySingle(item.id, profile, now())) {
              current = { ...current, processed: current.processed + 1 };
            }
          } else {
            const profile = profiles.get(item.id);
            if (profile && classifySingle(item.id, profile, now())) {
              current = { ...current, processed: current.processed + 1 };
            }
          }
        }

        for (const item of mergeSources) {
          const profile = profiles.get(item.id);
          if (!profile || item.mergeInto === null) continue;
          const merged = options.classificationRepository.mergeMiscTag({
            sourceId: item.id,
            targetId: item.mergeInto,
            profile,
            at: now(),
          });
          if (merged) {
            current = {
              ...current,
              processed: current.processed + 1,
              merged: current.merged + 1,
            };
            continue;
          }
          if (classifySingle(item.id, profile, now())) {
            current = { ...current, processed: current.processed + 1 };
          }
        }
        updateStatus({ remaining: remainingCount() });
      }
    }

    const remaining = remainingCount();
    if (remaining === 0) {
      options.classificationRepository.markLegacyMiscClassificationComplete(now());
      updateStatus({ state: 'completed', remaining: 0, completedAt: now() });
    } else {
      updateStatus({ state: 'incomplete', remaining });
    }
  }

  function start(force: boolean): boolean {
    if (pending) return false;
    if (!force && options.classificationRepository.isLegacyMiscClassificationComplete()) {
      updateStatus({
        state: 'completed',
        lockedSkipped: options.classificationRepository.countLockedMiscTags(),
        remaining: remainingCount(),
        completedAt: now(),
      });
      return false;
    }
    const task = classifyRemaining()
      .catch((error: unknown) => {
        reportError(error);
        updateStatus({ state: 'error', remaining: remainingCount() });
      })
      .finally(() => {
        if (pending === task) pending = undefined;
      });
    pending = task;
    return true;
  }

  return {
    startOnStartup() {
      start(false);
    },

    startManual() {
      return start(true);
    },

    status() {
      return { ...current };
    },

    async idle() {
      await pending;
    },
  };
}
