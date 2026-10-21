import type { AquariumConfig } from '../../config/schema.ts';
import { resolveSession } from '../../config/resolve.ts';
import { budgetState } from '../../llm/budget.ts';
import { callSlot } from '../../llm/slots.ts';
import type { StoredTag } from '../../store/affect-repo.ts';
import type { MessageStorageRecord, StoreRepository } from '../../store/repository.ts';
import { sessionId, type SessionKey } from '../shared/events.ts';
import type { ExtractTagsPromptTemplate, ReplySystemTemplate } from '../prompt/templates.ts';
import type { PipelineModelCall } from '../conversation/steps/types.ts';
import { classifyExtractFailure, extractFailureLabel, type ExtractFailureType } from './extract-error.ts';
import {
  asContradictItem,
  asNewItem,
  asObserveItem,
  isExternalLinkShareText,
  runExtract,
  type ExtractContradictItem,
  type ExtractNewItem,
  type ExtractSubjectItems,
  type ParsedExtractResponse,
} from './extract.ts';
import {
  applyTagContradiction,
  applyTagObservation,
  normalizeTagText,
} from './tags.ts';
import { isTagCategoryForScope, prepareTagText, type TagCategory, type TagDropReason } from './tag-model.ts';
import { mapMessageToMainIdentity } from '../profiles/account-identity.ts';
import { buildImpressionsPromptBlocks } from './prompt-blocks.ts';
import type { TagSubjectRepository } from '../../store/tag-subject-repo.ts';
import { recordScheduleTagDrop } from './record-tag-drop.ts';
import {
  createImpressionsRunState,
  type ImpressionsRunStateEvent,
  type ImpressionsRunStateSnapshot,
} from './run-state.ts';

export const EXTRACT_BATCH_TRIGGER = { messages: 60, sinceMs: 30 * 60 * 1000 } as const;
export const EXTRACT_SLOW_TRIGGER = { messages: 10, sinceMs: 6 * 60 * 60 * 1000 } as const;
export const EXTRACT_WINDOW_MESSAGES = 80;
export const TAG_TEXT_MIN = 2;
export const TAG_TEXT_MAX = 16;
export const MAX_NEW_PER_SUBJECT = 3;

export interface ExtractSummary {
  account: number;
  sessionId: string;
  status: 'done' | 'parse_error' | 'error' | 'budget';
  inserted: number;
  observed: number;
  superseded: number;
  dropped: number;
  droppedTagReasons: Partial<Record<TagDropReason, number>>;
  costCny: number;
  failureReason?: ExtractFailureType;
  failureHttpStatus?: number;
}

export interface ImpressionsPromptBlocks {
  groupTags?: string;
  memberTags?: string;
  droppedTags: number;
}

export interface ImpressionsServiceOptions {
  repository: StoreRepository;
  tagSubjects?: TagSubjectRepository;
  getConfig: () => AquariumConfig;
  callModel?: PipelineModelCall;
  now?: () => number;
  onError?: (error: unknown) => void;
  onWarn?: (message: string) => void;
  onExtract?: (summary: ExtractSummary) => void;
  onMemberSummaryCheck?: (account: number, userId: number, at: number) => void;
}

export interface ImpressionsService {
  maybeExtract(input: { session: SessionKey; now: number; template: ExtractTagsPromptTemplate }): void;
  tryAcquireSession(sessionId: string): (() => void) | undefined;
  isRunning(sessionId: string): boolean;
  extractionStatus(sessionId: string): ImpressionsRunStateSnapshot;
  subscribeRunState(listener: (event: ImpressionsRunStateEvent) => void): () => void;
  extractWindowUnderSessionLock(input: {
    session: SessionKey;
    records: MessageStorageRecord[];
    now: number;
    template: ExtractTagsPromptTemplate;
  }): Promise<ExtractSummary>;
  promptBlocks(input: {
    session: SessionKey;
    sessionId: string;
    senderId: number;
    senderName: string;
    now: number;
    template: ReplySystemTemplate;
  }): ImpressionsPromptBlocks;
  idle(): Promise<void>;
}

export function createImpressionsService(options: ImpressionsServiceOptions): ImpressionsService {
  const now = options.now ?? Date.now;
  const callModel = options.callModel ?? callSlot;
  const runState = createImpressionsRunState({ now, onError: reportError });
  const pending = new Set<Promise<void>>();

  function report(summary: ExtractSummary): void {
    try {
      options.onExtract?.(summary);
    } catch (error) {
      try {
        options.onError?.(error);
      } catch {
        // 追踪回调失败不影响其他任务。
      }
    }
  }

  function reportError(error: unknown): void {
    try {
      options.onError?.(error);
    } catch {
      // 后台提取失败不能影响回复。
    }
  }

  function quoteOf(plainText: string): string {
    return Array.from(plainText).slice(0, 40).join('');
  }

  const identityTextPattern = /^(?:[IE][NS][TF][JP]|(?:Ni|Ne|Si|Se|Ti|Te|Fi|Fe)(?: 主导| 辅助)?)$/u;

  function applySubject(
    subject: ExtractSubjectItems,
    current: StoredTag[],
    account: number,
    sessionKey: string,
    userId: number | null,
    recordsById: Map<string, {
      time: number;
      plainText: string;
      senderId: number;
      isSelf: boolean;
      externalLinkShare: boolean;
    }>,
    at: number,
    counters: {
      inserted: number;
      observed: number;
      superseded: number;
      dropped: number;
      droppedTagReasons: Partial<Record<TagDropReason, number>>;
    },
  ): void {
    let newCount = 0;
    const incrementedTagIds = new Set<number>();
    const recordDrop = (reason?: TagDropReason, dropped?: { category: TagCategory; text: string }) => {
      counters.dropped += 1;
      if (reason) counters.droppedTagReasons[reason] = (counters.droppedTagReasons[reason] ?? 0) + 1;
      if (reason === 'schedule_by_stats' && dropped) recordScheduleTagDrop(options.repository, { account, sessionId: sessionKey, userId, ...dropped, time: at }, reportError);
    };
    const isTagVetoed = (category: TagCategory, subjectPath: string | null, textNorm: string): boolean =>
      options.repository.isTagVetoed({ account, sessionId: sessionKey, userId, category, subject: subjectPath, textNorm });

    const evidenceFor = (messageId: string, evidenceUserId: number | null) => {
      const record = recordsById.get(messageId);
      if (!record || record.isSelf || record.externalLinkShare) return undefined;
      if (evidenceUserId !== null && record.senderId !== evidenceUserId) return undefined;
      return {
        messageId,
        time: record.time,
        quote: quoteOf(record.plainText),
      };
    };

    const profileFor = (item: ExtractNewItem | ExtractContradictItem) => {
      const record = recordsById.get(item.messageId);
      if (!record) return undefined;
      if (!isTagCategoryForScope(item.category, userId === null ? 'group' : 'member')) return undefined;
      if (item.category === 'identity' && !identityTextPattern.test(item.text)) return undefined;
      let origin = item.origin;
      if (item.category === 'identity' && origin === 'self_report'
        && (record.senderId !== userId || !record.plainText.toLowerCase().includes(item.text.toLowerCase()))) {
        origin = 'inferred';
      }
      return {
        category: item.category,
        subject: item.subject,
        polarity: item.polarity,
        origin,
        locked: item.sensitive,
      };
    };

    const evidenceForItem = (item: ExtractNewItem | ExtractContradictItem) => evidenceFor(
      item.messageId,
      item.category === 'identity' && item.origin === 'self_report' ? null : userId,
    );

    const observe = (
      target: StoredTag,
      messageId: string,
      evidence: ReturnType<typeof evidenceFor>,
      lockSensitive = false,
    ): boolean => {
      if (!evidence || target.locked) return false;
      const outcome = applyTagObservation(current, {
        text: target.text,
        norm: target.norm,
        messageId,
        time: evidence.time,
        quote: evidence.quote,
      });
      if (outcome.action !== 'observe') return false;

      const alreadyIncremented = incrementedTagIds.has(target.id);
      const update = {
        samples: alreadyIncremented ? target.samples : outcome.samples,
        status: alreadyIncremented ? target.status : outcome.status,
        lastSeen: outcome.lastSeen,
        evidence: outcome.evidence,
        updatedAt: at,
        ...(lockSensitive ? { locked: true } : {}),
      };
      if (!alreadyIncremented) incrementedTagIds.add(target.id);
      options.repository.updateTag(outcome.id, update);
      Object.assign(target, update);
      counters.observed += 1;
      return true;
    };

    for (const raw of subject.observe) {
      const item = asObserveItem(raw);
      const target = item ? current.find((tag) => tag.id === item.id) : undefined;
      const evidence = item ? evidenceFor(item.messageId, userId) : undefined;
      if (!item || !target || !evidence) {
        counters.dropped += 1;
        continue;
      }
      if (isTagVetoed(target.category, target.subject, target.norm)) { recordDrop('vetoed'); continue; }
      if (!observe(target, item.messageId, evidence)) counters.dropped += 1;
    }

    for (const raw of subject.new) {
      const item = asNewItem(raw);
      if (!item || newCount >= MAX_NEW_PER_SUBJECT) {
        recordDrop();
        continue;
      }
      const sourceRecord = recordsById.get(item.messageId);
      const preparedText = prepareTagText(item.category, item.text, sourceRecord ? [sourceRecord.plainText] : []);
      if (!preparedText.ok) {
        recordDrop(preparedText.reason, { category: item.category, text: item.text });
        continue;
      }
      const normalizedItem = { ...item, text: preparedText.text };
      const evidence = evidenceForItem(normalizedItem);
      const profile = profileFor(normalizedItem);
      if (!evidence || !profile) {
        recordDrop();
        continue;
      }
      const norm = normalizeTagText(normalizedItem.text);
      if (isTagVetoed(profile.category, profile.subject, norm)) { recordDrop('vetoed'); continue; }
      const existing = current.find((tag) => tag.norm === norm);
      if (existing && (existing.locked || incrementedTagIds.has(existing.id))) {
        recordDrop();
        continue;
      }
      const outcome = applyTagObservation(current, {
        text: normalizedItem.text,
        norm,
        messageId: item.messageId,
        time: evidence.time,
        quote: evidence.quote,
      });
      if (outcome.action === 'insert') {
        const id = options.repository.insertTag({
          account,
          sessionId: sessionKey,
          userId,
          text: outcome.text,
          norm: outcome.norm,
          ...profile,
          status: 'candidate',
          source: 'auto',
          samples: 1,
          evidence: outcome.evidence,
          firstSeen: evidence.time,
          lastSeen: evidence.time,
          supersededBy: null,
          updatedAt: at,
        });
        const inserted: StoredTag = {
          id,
          account,
          sessionId: sessionKey,
          userId,
          text: outcome.text,
          norm: outcome.norm,
          ...profile,
          status: 'candidate',
          source: 'auto',
          samples: 1,
          evidence: outcome.evidence,
          firstSeen: evidence.time,
          lastSeen: evidence.time,
          supersededBy: null,
          updatedAt: at,
        };
        current.push(inserted);
        incrementedTagIds.add(id);
        counters.inserted += 1;
        newCount += 1;
      } else if (outcome.action === 'observe') {
        if (!existing || !observe(existing, normalizedItem.messageId, evidence, profile.locked)) {
          recordDrop();
          continue;
        }
        newCount += 1;
      } else {
        recordDrop();
      }
    }

    for (const raw of subject.contradict) {
      const item = asContradictItem(raw);
      if (!item || newCount >= MAX_NEW_PER_SUBJECT) {
        recordDrop();
        continue;
      }
      const sourceRecord = recordsById.get(item.messageId);
      const preparedText = prepareTagText(item.category, item.text, sourceRecord ? [sourceRecord.plainText] : []);
      if (!preparedText.ok) {
        recordDrop(preparedText.reason, { category: item.category, text: item.text });
        continue;
      }
      const normalizedItem = { ...item, text: preparedText.text };
      const evidence = evidenceForItem(normalizedItem);
      const profile = profileFor(normalizedItem);
      const target = current.find((tag) => tag.id === item.id);
      if (!evidence || !profile || !target || target.locked || target.status === 'superseded') {
        recordDrop();
        continue;
      }
      if (isTagVetoed(profile.category, profile.subject, normalizeTagText(normalizedItem.text))) {
        recordDrop('vetoed');
        continue;
      }
      const outcome = applyTagContradiction(current, {
        id: normalizedItem.id,
        text: normalizedItem.text,
        messageId: normalizedItem.messageId,
        time: evidence.time,
        quote: evidence.quote,
      });
      if (outcome.action !== 'insert') {
        recordDrop();
        continue;
      }
      const id = options.repository.insertTag({
        account,
        sessionId: sessionKey,
        userId,
        text: outcome.text,
        norm: outcome.norm,
        ...profile,
        status: 'candidate',
        source: 'auto',
        samples: 1,
        evidence: outcome.evidence,
        firstSeen: evidence.time,
        lastSeen: evidence.time,
        supersededBy: null,
        updatedAt: at,
      });
      const superseded = {
        status: 'superseded',
        supersededBy: id,
        updatedAt: at,
      } as const;
      options.repository.updateTag(outcome.supersedes, superseded);
      Object.assign(target, superseded);
      current.push({
        id,
        account,
        sessionId: sessionKey,
        userId,
        text: outcome.text,
        norm: outcome.norm,
        ...profile,
        status: 'candidate',
        source: 'auto',
        samples: 1,
        evidence: outcome.evidence,
        firstSeen: evidence.time,
        lastSeen: evidence.time,
        supersededBy: null,
        updatedAt: at,
      });
      newCount += 1;
      counters.inserted += 1;
      counters.superseded += 1;
    }
  }

  async function runExtraction(
    config: AquariumConfig,
    session: SessionKey,
    sessionKey: string,
    at: number,
    template: ExtractTagsPromptTemplate,
    records: MessageStorageRecord[] = options.repository.recentMessages(sessionKey, EXTRACT_WINDOW_MESSAGES),
    updateTagRun = true,
  ): Promise<ExtractSummary> {
    const account = session.account;
    let attemptedProvider = config.slots.extract?.[0]?.provider ?? 'unknown';
    let attemptedModel = config.slots.extract?.[0]?.model ?? 'unknown';
    const counters = {
      inserted: 0,
      observed: 0,
      superseded: 0,
      dropped: 0,
      droppedTagReasons: {} as Partial<Record<TagDropReason, number>>,
    };
    let costCny = 0;
    let failureReason: ExtractFailureType | undefined;
    let failureHttpStatus: number | undefined;
    const finish = (status: ExtractSummary['status']): ExtractSummary => {
      const summary = {
        account, sessionId: sessionKey, status, ...counters, costCny,
        ...(failureReason ? { failureReason } : {}),
        ...(failureHttpStatus !== undefined ? { failureHttpStatus } : {}),
      };
      report(summary);
      return summary;
    };

    if (budgetState(config, options.repository.costToday()) === 'exceeded') {
      return finish('budget');
    }

    const identityRecords = records.map((record) => mapMessageToMainIdentity(options.repository, account, record));
    const recordsById = new Map(identityRecords.map((record) => [
      record.messageId,
      {
        time: record.time,
        plainText: record.plainText,
        senderId: record.senderId,
        isSelf: record.isSelf,
        externalLinkShare: isExternalLinkShareText(record.plainText),
      },
    ]));
    const senderIds = new Set(identityRecords
      .filter((record) => !record.isSelf && record.senderId !== account)
      .map((record) => record.senderId));
    const keepStatuses = (tag: StoredTag): boolean => tag.status === 'candidate' || tag.status === 'confirmed';
    const groupTags = options.repository.listTagsForSubject(account, sessionKey, null).filter(keepStatuses);
    const memberTags = [...senderIds].map((userId) => ({
      userId,
      tags: options.repository.listTagsForSubject(account, sessionKey, userId).filter(keepStatuses),
    }));

    const selected = config.slots.extract?.[0];
    const selectedProvider = selected?.provider ?? 'unknown';
    const selectedModel = selected && config.providers[selected.provider]?.kind === 'cli'
      ? 'cli-model'
      : selected?.model ?? 'unknown';
    const startedAt = now();
    const result = await runExtract(
      identityRecords,
      {
        group: groupTags,
        members: memberTags,
        subjects: options.tagSubjects
          ? [
            ...options.tagSubjects.listTagSubjects(account, 'topic'),
            ...options.tagSubjects.listTagSubjects(account, 'fandom'),
          ]
          : [],
      },
      template,
      async (slot, messages) => {
        const response = await callModel(slot, messages, {
          config,
          account,
          costToday: () => options.repository.costToday(),
          recordUsage: (usage) => {
            attemptedProvider = usage.provider;
            attemptedModel = usage.model === 'cli-model'
              && config.providers[usage.provider]?.kind === 'cli'
              ? `cli:${usage.provider}`
              : usage.model;
            options.repository.recordUsage({ ...usage, account });
          },
          now,
        });
        costCny += response.usage.costCny;
        return response;
      },
    );

    const newestTime = records.reduce((max, record) => Math.max(max, record.time), 0);
    if (updateTagRun) {
      options.repository.saveTagRun({
        account,
        sessionId: sessionKey,
        lastRunAt: at,
        lastMessageTime: newestTime > 0 ? newestTime : null,
      });
    }

    if (!result.ok) {
      if (result.reason === 'extract_error') {
        const classified = classifyExtractFailure(result.error);
        failureReason = classified.type;
        const elapsedMs = Math.max(0, now() - startedAt);
        const message = `印象提取失败：slot=extract provider=${attemptedProvider} model=${attemptedModel} durationMs=${elapsedMs} reason=${extractFailureLabel(classified)}`;
        try { options.onWarn?.(message); } catch { /* 日志回调失败不影响提取结果。 */ }
        if (classified.httpStatus !== undefined) failureHttpStatus = classified.httpStatus;
      } else {
        failureReason = 'other';
      }
      return finish(result.reason === 'extract_parse_error' ? 'parse_error' : 'error');
    }

    const parsed: ParsedExtractResponse = result.parsed;
    applySubject(parsed.group, groupTags, account, sessionKey, null, recordsById, at, counters);
    for (const member of parsed.members) {
      if (!senderIds.has(member.userId)) {
        counters.dropped += member.observe.length + member.new.length + member.contradict.length;
        continue;
      }
      const current = memberTags.find((entry) => entry.userId === member.userId)?.tags ?? [];
      applySubject(member, current, account, sessionKey, member.userId, recordsById, at, counters);
    }
    for (const userId of senderIds) {
      try {
        options.onMemberSummaryCheck?.(account, userId, at);
      } catch (error) {
        reportError(error);
      }
    }

    return finish('done');
  }

  return {
    tryAcquireSession: runState.tryAcquire,
    isRunning: runState.isRunning,
    extractionStatus: runState.status,
    subscribeRunState: runState.subscribe,

    extractWindowUnderSessionLock(input) {
      if (input.session.kind !== 'group') throw new RangeError('印象提取只支持群聊');
      const key = sessionId(input.session);
      if (!runState.isRunning(key)) throw new Error('extractWindowUnderSessionLock requires the group lock');
      return runExtraction(options.getConfig(), input.session, key, input.now, input.template, input.records, false);
    },

    maybeExtract(input) {
      if (input.session.kind !== 'group') return;
      const sessionKey = sessionId(input.session);
      if (runState.isRunning(sessionKey)) return;

      const config = options.getConfig();
      if (!resolveSession(config, input.session).enabled) return;

      const run = options.repository.getTagRun(input.session.account, sessionKey);
      const lastRunAt = run?.lastRunAt ?? 0;
      const lastMessageTime = run?.lastMessageTime ?? 0;
      const newest = options.repository.lastMessageTime(sessionKey) ?? 0;
      if (newest <= lastMessageTime) return;

      const n = options.repository.countMessagesAfter(sessionKey, lastMessageTime);
      const sinceRun = input.now - lastRunAt;
      const due = (n >= EXTRACT_BATCH_TRIGGER.messages && sinceRun >= EXTRACT_BATCH_TRIGGER.sinceMs)
        || (n >= EXTRACT_SLOW_TRIGGER.messages && sinceRun >= EXTRACT_SLOW_TRIGGER.sinceMs);
      if (!due) return;

      const release = runState.tryAcquire(sessionKey);
      if (!release) return;
      const task = runExtraction(config, input.session, sessionKey, input.now, input.template)
        .then(() => undefined)
        .catch(reportError)
        .finally(release);
      pending.add(task);
      void task.finally(() => pending.delete(task));
    },

    promptBlocks(input) {
      return buildImpressionsPromptBlocks(options.repository, input);
    },

    async idle() {
      while (pending.size > 0) {
        await Promise.all([...pending]);
      }
    },
  };
}
