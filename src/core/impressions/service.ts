import type { AquariumConfig } from '../../config/schema.ts';
import { resolveSession } from '../../config/resolve.ts';
import { budgetState } from '../../llm/budget.ts';
import { callSlot } from '../../llm/slots.ts';
import type { StoredTag } from '../../store/affect-repo.ts';
import type { StoreRepository } from '../../store/repository.ts';
import { sessionId, type SessionKey } from '../events.ts';
import type { ExtractTagsPromptTemplate, ReplySystemTemplate } from '../prompt-templates.ts';
import type { PipelineModelCall } from '../steps/types.ts';
import {
  asContradictItem,
  asNewItem,
  asObserveItem,
  runExtract,
  type ExtractSubjectItems,
  type ParsedExtractResponse,
} from './extract.ts';
import {
  applyTagContradiction,
  applyTagObservation,
  GROUP_TAGS_LIMIT,
  MEMBER_TAGS_LIMIT,
  normalizeTagText,
  selectInjectableTags,
} from './tags.ts';

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
}

export interface ImpressionsPromptBlocks {
  groupTags?: string;
  memberTags?: string;
  droppedTags: number;
}

export interface ImpressionsServiceOptions {
  repository: StoreRepository;
  getConfig: () => AquariumConfig;
  callModel?: PipelineModelCall;
  now?: () => number;
  onError?: (error: unknown) => void;
  onExtract?: (summary: ExtractSummary) => void;
}

export interface ImpressionsService {
  maybeExtract(input: { session: SessionKey; now: number; template: ExtractTagsPromptTemplate }): void;
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

function textLength(text: string): number {
  return Array.from(text).length;
}

export function createImpressionsService(options: ImpressionsServiceOptions): ImpressionsService {
  const now = options.now ?? Date.now;
  const callModel = options.callModel ?? callSlot;
  const running = new Set<string>();
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

  function applySubject(
    subject: ExtractSubjectItems,
    current: StoredTag[],
    account: number,
    sessionKey: string,
    userId: number | null,
    recordsById: Map<string, { time: number; plainText: string; senderId: number; isSelf: boolean }>,
    at: number,
    counters: { inserted: number; observed: number; superseded: number; dropped: number },
  ): void {
    let newCount = 0;
    const incrementedTagIds = new Set<number>();

    const evidenceFor = (messageId: string, evidenceUserId: number | null) => {
      const record = recordsById.get(messageId);
      if (!record || record.isSelf) return undefined;
      if (evidenceUserId !== null && record.senderId !== evidenceUserId) return undefined;
      return {
        messageId,
        time: record.time,
        quote: quoteOf(record.plainText),
      };
    };

    const observe = (target: StoredTag, messageId: string, evidence: ReturnType<typeof evidenceFor>): boolean => {
      if (!evidence) return false;
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
      if (!observe(target, item.messageId, evidence)) counters.dropped += 1;
    }

    for (const raw of subject.new) {
      const item = asNewItem(raw);
      if (!item || newCount >= MAX_NEW_PER_SUBJECT
        || textLength(item.text) < TAG_TEXT_MIN || textLength(item.text) > TAG_TEXT_MAX) {
        counters.dropped += 1;
        continue;
      }
      const evidence = evidenceFor(item.messageId, userId);
      if (!evidence) {
        counters.dropped += 1;
        continue;
      }
      const norm = normalizeTagText(item.text);
      const existing = current.find((tag) => tag.norm === norm);
      if (existing && incrementedTagIds.has(existing.id)) {
        counters.dropped += 1;
        continue;
      }
      const outcome = applyTagObservation(current, {
        text: item.text,
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
        if (!existing || !observe(existing, item.messageId, evidence)) {
          counters.dropped += 1;
          continue;
        }
        newCount += 1;
      } else {
        counters.dropped += 1;
      }
    }

    for (const raw of subject.contradict) {
      const item = asContradictItem(raw);
      if (!item || newCount >= MAX_NEW_PER_SUBJECT
        || textLength(item.text) < TAG_TEXT_MIN || textLength(item.text) > TAG_TEXT_MAX) {
        counters.dropped += 1;
        continue;
      }
      const evidence = evidenceFor(item.messageId, userId);
      const target = current.find((tag) => tag.id === item.id);
      if (!evidence || !target || target.status === 'superseded') {
        counters.dropped += 1;
        continue;
      }
      const outcome = applyTagContradiction(current, {
        id: item.id,
        text: item.text,
        messageId: item.messageId,
        time: evidence.time,
        quote: evidence.quote,
      });
      if (outcome.action !== 'insert') {
        counters.dropped += 1;
        continue;
      }
      const id = options.repository.insertTag({
        account,
        sessionId: sessionKey,
        userId,
        text: outcome.text,
        norm: outcome.norm,
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
  ): Promise<void> {
    const account = session.account;
    const counters = { inserted: 0, observed: 0, superseded: 0, dropped: 0 };

    if (budgetState(config, options.repository.costToday()) === 'exceeded') {
      report({ account, sessionId: sessionKey, status: 'budget', ...counters });
      return;
    }

    const records = options.repository.recentMessages(sessionKey, EXTRACT_WINDOW_MESSAGES);
    const recordsById = new Map(records.map((record) => [
      record.messageId,
      {
        time: record.time,
        plainText: record.plainText,
        senderId: record.senderId,
        isSelf: record.isSelf,
      },
    ]));
    const senderIds = new Set<number>();
    for (const record of records) {
      if (!record.isSelf && record.senderId !== account) senderIds.add(record.senderId);
    }
    const keepStatuses = (tag: StoredTag): boolean => tag.status === 'candidate' || tag.status === 'confirmed';
    const groupTags = options.repository.listTagsForSubject(account, sessionKey, null).filter(keepStatuses);
    const memberTags = [...senderIds].map((userId) => ({
      userId,
      tags: options.repository.listTagsForSubject(account, sessionKey, userId).filter(keepStatuses),
    }));

    const result = await runExtract(
      records,
      { group: groupTags, members: memberTags },
      template,
      (slot, messages) => callModel(slot, messages, {
        config,
        account,
        costToday: () => options.repository.costToday(),
        recordUsage: (usage) => options.repository.recordUsage({ ...usage, account }),
        now,
      }),
    ).catch((error: unknown) => {
      reportError(error);
      return { ok: false, reason: 'extract_error' } as const;
    });

    const newestTime = records.reduce((max, record) => Math.max(max, record.time), 0);
    options.repository.saveTagRun({
      account,
      sessionId: sessionKey,
      lastRunAt: at,
      lastMessageTime: newestTime > 0 ? newestTime : null,
    });

    if (!result.ok) {
      report({
        account,
        sessionId: sessionKey,
        status: result.reason === 'extract_parse_error' ? 'parse_error' : 'error',
        ...counters,
      });
      return;
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

    report({ account, sessionId: sessionKey, status: 'done', ...counters });
  }

  return {
    maybeExtract(input) {
      if (input.session.kind !== 'group') return;
      const sessionKey = sessionId(input.session);
      if (running.has(sessionKey)) return;

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

      running.add(sessionKey);
      const task = runExtraction(config, input.session, sessionKey, input.now, input.template)
        .catch(reportError)
        .finally(() => running.delete(sessionKey));
      pending.add(task);
      void task.finally(() => pending.delete(task));
    },

    promptBlocks(input) {
      if (input.session.kind !== 'group') return { droppedTags: 0 };
      const account = input.session.account;
      const at = input.now;
      const groupSelection = selectInjectableTags(
        options.repository.listTagsForSubject(account, input.sessionId, null),
        at,
        GROUP_TAGS_LIMIT,
      );
      const memberSelection = input.senderId === account
        ? { tags: [] as StoredTag[], dropped: 0 }
        : selectInjectableTags(
          options.repository.listTagsForSubject(account, input.sessionId, input.senderId),
          at,
          MEMBER_TAGS_LIMIT,
        );
      const blocks: ImpressionsPromptBlocks = {
        droppedTags: groupSelection.dropped + memberSelection.dropped,
      };
      if (groupSelection.tags.length > 0) {
        blocks.groupTags = input.template.groupTags
          .replaceAll('{{tags}}', groupSelection.tags.map((tag) => tag.text).join('、'));
      }
      if (memberSelection.tags.length > 0) {
        blocks.memberTags = input.template.memberTags
          .replaceAll('{{name}}', JSON.stringify(input.senderName))
          .replaceAll('{{tags}}', memberSelection.tags.map((tag) => tag.text).join('、'));
      }
      return blocks;
    },

    async idle() {
      while (pending.size > 0) {
        await Promise.all([...pending]);
      }
    },
  };
}
