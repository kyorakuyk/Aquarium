import type { AquariumConfig } from '../../config/schema.ts';
import { budgetState } from '../../llm/budget.ts';
import { callSlot } from '../../llm/slots.ts';
import type { MessageStorageRecord, StoreRepository } from '../../store/repository.ts';
import type { NewPrivateFactRecord, PrivateFactEvidence, PrivateFactRecord } from '../../store/privacy-repo.ts';
import type { ExtractPrivatePromptTemplate, ReplySystemTemplate } from '../prompt/templates.ts';
import { persistTagPromptStates } from '../impressions/prompt-state.ts';
import { buildPrivateExtractionMessages, parsePrivateFactResponse } from './extract.ts';
import { buildPrivateFactsBlock } from './prompt.ts';
import { decide } from './policy.ts';
import { syncKinRelays } from './kin-relay.ts';
import type { PipelineModelCall } from '../conversation/steps/types.ts';
import { sessionId, type SessionKey } from '../shared/events.ts';

const twentyMessages = 20;
const fiveMessages = 5;
const thirtyMinutes = 30 * 60 * 1_000;
const sixHours = 6 * 60 * 60 * 1_000;

export interface PrivateFactsSummary {
  account: number;
  sessionId: string;
  status: 'done' | 'parse_error' | 'failed' | 'budget';
  inserted: number;
  updated: number;
  deleted: number;
  dropped: number;
}

export interface PrivateFactsService {
  promptBlock(input: {
    session: SessionKey;
    name: string;
    now: number;
    template: ReplySystemTemplate;
  }): string | undefined;
  maybeExtract(input: {
    session: SessionKey;
    messageId: string;
    senderId: number;
    now: number;
    template: ExtractPrivatePromptTemplate;
  }): void;
  extractWindowUnderSessionLock(input: {
    session: SessionKey;
    records: MessageStorageRecord[];
    now: number;
    template: ExtractPrivatePromptTemplate;
  }): Promise<PrivateFactsSummary>;
  idle(): Promise<void>;
}

export interface PrivateFactsServiceOptions {
  repository: StoreRepository;
  getConfig: () => AquariumConfig;
  callModel?: PipelineModelCall;
  onExtract?: (summary: PrivateFactsSummary) => void;
  onError?: (context: { account: number; sessionId: string }) => void;
}

interface ExtractInput {
  session: SessionKey;
  messageId: string;
  senderId: number;
  now: number;
  template: ExtractPrivatePromptTemplate;
}

type ExtractStatus = PrivateFactsSummary['status'];

function textLength(value: string): number {
  return Array.from(value).length;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function validText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  const length = textLength(text);
  return length >= 4 && length <= 40 ? text : undefined;
}

function validKeywords(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length < 2 || value.length > 5) return undefined;
  const keywords = value.map((item) => typeof item === 'string' ? item.trim() : '');
  if (keywords.some((item) => textLength(item) < 2 || textLength(item) > 8)
    || new Set(keywords).size !== keywords.length) return undefined;
  return keywords;
}

function validId(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function validMessageId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function evidenceFor(message: { messageId: string; time: number; plainText: string }): PrivateFactEvidence {
  return { messageId: message.messageId, time: message.time, quote: Array.from(message.plainText).slice(0, 40).join('') };
}

function appendEvidence(current: readonly PrivateFactEvidence[], next: PrivateFactEvidence): PrivateFactEvidence[] {
  return [...current.filter((item) => item.messageId !== next.messageId), next].slice(-5);
}

function allowedForPrivateSession(fact: PrivateFactRecord, sessionIdValue: string, ownerId: number): boolean {
  return decide({
    info: {
      origin: 'private',
      sessionId: fact.sessionId,
      ownerId: fact.ownerId,
      level: fact.level,
    },
    target: { kind: 'private', sessionId: sessionIdValue, peerId: ownerId },
    purpose: 'prompt',
  }) === 'allow';
}

function emptySummary(account: number, sessionIdValue: string, status: ExtractStatus): PrivateFactsSummary {
  return { account, sessionId: sessionIdValue, status, inserted: 0, updated: 0, deleted: 0, dropped: 0 };
}

export function createPrivateFactsService(options: PrivateFactsServiceOptions): PrivateFactsService {
  const pending = new Set<Promise<void>>();
  const running = new Set<string>();
  const queued = new Map<string, ExtractInput>();
  const callModel = options.callModel ?? callSlot;

  function report(summary: PrivateFactsSummary): void {
    try {
      options.onExtract?.(summary);
    } catch {
      // 统计或日志失败不能影响私聊事实持久化。
    }
  }

  function reportError(account: number, sessionIdValue: string): void {
    try {
      options.onError?.({ account, sessionId: sessionIdValue });
    } catch {
      // 错误上报不能泄漏私聊内容或中断处理。
    }
  }

  function saveRun(input: ExtractInput, sessionIdValue: string, lastMessageTime: number): void {
    options.repository.savePrivacyRun({
      account: input.session.account,
      sessionId: sessionIdValue,
      lastRunAt: input.now,
      lastMessageTime,
    });
  }

  function applyResult(input: ExtractInput, sessionIdValue: string, records: ReturnType<StoreRepository['recentMessages']>, existingFacts: PrivateFactRecord[], result: unknown): PrivateFactsSummary {
    const summary = emptySummary(input.session.account, sessionIdValue, 'done');
    const parsed = parsePrivateFactResponse(typeof result === 'string' ? result : '');
    if (!parsed) {
      summary.status = 'parse_error';
      return summary;
    }

    const ownerId = input.session.kind === 'private' ? input.session.peer : 0;
    const sourceMessages = new Map(records
      .filter((record) => record.sessionId === sessionIdValue && !record.isSelf && record.senderId === ownerId)
      .map((record) => [record.messageId, record]));
    const factsById = new Map(existingFacts.map((fact) => [fact.id, fact]));
    const handledIds = new Set<number>();
    const newTexts = new Set(existingFacts.map((fact) => fact.text.trim().toLocaleLowerCase()));

    for (const candidate of parsed.new) {
      const item = asRecord(candidate);
      const text = validText(item?.text);
      const keywords = validKeywords(item?.keywords);
      const messageId = validMessageId(item?.messageId);
      const source = messageId ? sourceMessages.get(messageId) : undefined;
      const normalized = text?.toLocaleLowerCase();
      if (!text || !keywords || !source || !normalized || newTexts.has(normalized)) {
        summary.dropped += 1;
        continue;
      }
      newTexts.add(normalized);
      const fact: NewPrivateFactRecord = {
        account: input.session.account,
        ownerId,
        sessionId: sessionIdValue,
        text,
        keywords,
        level: 'L0',
        levelSource: 'auto',
        mentions: 0,
        mentionEvidence: [],
        evidence: [evidenceFor(source)],
        status: 'active',
        createdAt: input.now,
        updatedAt: input.now,
      };
      options.repository.insertPrivateFact(fact);
      summary.inserted += 1;
    }

    for (const candidate of parsed.update) {
      const item = asRecord(candidate);
      const id = validId(item?.id);
      const text = validText(item?.text);
      const keywords = validKeywords(item?.keywords);
      const messageId = validMessageId(item?.messageId);
      const fact = id ? factsById.get(id) : undefined;
      const source = messageId ? sourceMessages.get(messageId) : undefined;
      if (!id || !text || !keywords || !fact || !source || handledIds.has(id)) {
        summary.dropped += 1;
        continue;
      }
      options.repository.updatePrivateFact(id, {
        text,
        keywords,
        evidence: appendEvidence(fact.evidence, evidenceFor(source)),
        updatedAt: input.now,
      });
      handledIds.add(id);
      summary.updated += 1;
    }

    for (const candidate of parsed.obsolete) {
      const item = asRecord(candidate);
      const id = validId(item?.id);
      const fact = id ? factsById.get(id) : undefined;
      if (!id || !fact || handledIds.has(id)) {
        summary.dropped += 1;
        continue;
      }
      options.repository.markPrivateFactDeleted(id, input.now);
      handledIds.add(id);
      summary.deleted += 1;
    }

    return summary;
  }

  async function runExtraction(
    input: ExtractInput,
    sessionIdValue: string,
    config: AquariumConfig,
    records: ReturnType<StoreRepository['recentMessages']>,
    newestMessageTime: number,
  ): Promise<PrivateFactsSummary> {
    const summary = emptySummary(input.session.account, sessionIdValue, 'failed');
    if (budgetState(config, options.repository.costToday()) === 'exceeded') {
      const skipped = { ...summary, status: 'budget' as const };
      report(skipped);
      return skipped;
    }
    const target = { kind: 'private' as const, sessionId: sessionIdValue, peerId: input.session.kind === 'private' ? input.session.peer : 0 };
    const allowedRecords = records.filter((record) => decide({
      info: { origin: 'private', sessionId: record.sessionId, ownerId: input.session.kind === 'private' ? input.session.peer : null, level: 'L0' },
      target,
      purpose: 'prompt',
    }) === 'allow');
    const existingFacts = options.repository
      .listPrivateFactsForOwner(input.session.account, target.peerId)
      .filter((fact) => allowedForPrivateSession(fact, sessionIdValue, target.peerId));
    const messages = buildPrivateExtractionMessages({
      records: allowedRecords,
      ownerId: target.peerId,
      existing: existingFacts.map(({ id, text, keywords }) => ({ id, text, keywords })),
      template: input.template,
    });

    let responseText: string;
    try {
      const response = await callModel('extract', messages, {
        config,
        account: input.session.account,
        costToday: () => options.repository.costToday(),
        recordUsage: options.repository.recordUsage,
        now: () => input.now,
      });
      responseText = response.text;
    } catch {
      reportError(input.session.account, sessionIdValue);
      report(summary);
      return summary;
    }

    try {
      const applied = applyResult(input, sessionIdValue, records, existingFacts, responseText);
      try {
        syncKinRelays(options.repository, input.now);
      } catch {
        reportError(input.session.account, sessionIdValue);
      }
      saveRun(input, sessionIdValue, newestMessageTime);
      report(applied);
      return applied;
    } catch {
      reportError(input.session.account, sessionIdValue);
      report(summary);
      return summary;
    }
  }

  function checkAndStart(input: ExtractInput, sessionIdValue: string, storedMessage: NonNullable<ReturnType<StoreRepository['messageBySessionAndId']>>): void {
    const config = options.getConfig();
    if (!config.privacy.enabled) return;
    const run = options.repository.getPrivacyRun(input.session.account, sessionIdValue);
    const lastMessageTime = run?.lastMessageTime ?? 0;
    const newMessageCount = options.repository.countPrivateOwnerMessagesAfter(sessionIdValue, input.senderId, lastMessageTime);
    const elapsed = input.now - (run?.lastRunAt ?? 0);
    const due = (newMessageCount >= twentyMessages && elapsed >= thirtyMinutes)
      || (newMessageCount >= fiveMessages && elapsed >= sixHours);
    if (!due) return;

    if (budgetState(config, options.repository.costToday()) === 'exceeded') {
      report(emptySummary(input.session.account, sessionIdValue, 'budget'));
      return;
    }

    const records = options.repository.recentMessages(sessionIdValue, 60);
    const newestMessageTime = records
      .filter((record) => !record.isSelf && record.senderId === input.senderId && record.time > lastMessageTime)
      .reduce((latest, record) => Math.max(latest, record.time), Math.max(lastMessageTime, storedMessage.time));
    running.add(sessionIdValue);

    let task: Promise<void>;
    task = runExtraction(input, sessionIdValue, config, records, newestMessageTime)
      .then((summary) => {
        running.delete(sessionIdValue);
        pending.delete(task);
        const next = queued.get(sessionIdValue);
        queued.delete(sessionIdValue);
        if (next && (summary.status === 'done' || summary.status === 'parse_error')) {
          const nextMessage = options.repository.messageBySessionAndId(sessionIdValue, next.messageId);
          if (nextMessage) checkAndStart(next, sessionIdValue, nextMessage);
        }
      })
      .catch(() => {
        running.delete(sessionIdValue);
        pending.delete(task);
        queued.delete(sessionIdValue);
        reportError(input.session.account, sessionIdValue);
      });
    pending.add(task);
  }

  return {
    promptBlock(input) {
      if (input.session.kind !== 'private') return undefined;
      const sessionIdValue = sessionId(input.session);
      try {
        if (!options.getConfig().privacy.enabled) return undefined;
        return buildPrivateFactsBlock({
          ...input,
          facts: options.repository.listPrivateFactsForOwner(input.session.account, input.session.peer),
          groupTags: options.repository.listGroupTagsForUser(input.session.account, input.session.peer),
          onTagPromptStates: (updates) => persistTagPromptStates(options.repository, updates),
        });
      } catch {
        reportError(input.session.account, sessionIdValue);
        return undefined;
      }
    },

    maybeExtract(input) {
      if (input.session.kind !== 'private' || input.session.peer !== input.senderId
        || !Number.isSafeInteger(input.senderId) || input.senderId <= 0
        || input.senderId === input.session.account
        || !Number.isFinite(input.now) || input.messageId.length === 0) return;
      const sessionIdValue = sessionId(input.session);
      const storedMessage = options.repository.messageBySessionAndId(sessionIdValue, input.messageId);
      if (!storedMessage || storedMessage.isSelf || storedMessage.senderId !== input.senderId) return;
      if (running.has(sessionIdValue)) {
        queued.set(sessionIdValue, input);
        return;
      }
      checkAndStart(input, sessionIdValue, storedMessage);
    },

    async extractWindowUnderSessionLock(input) {
      if (input.session.kind !== 'private' || !Number.isSafeInteger(input.session.peer)
        || input.session.peer <= 0 || !Number.isSafeInteger(input.now) || input.now < 0) {
        throw new RangeError('私聊 memo 整理参数无效');
      }
      const sessionIdValue = sessionId(input.session);
      if (input.records.some((record) => record.sessionId !== sessionIdValue)) {
        throw new RangeError('私聊 memo 会话不匹配');
      }
      const config = options.getConfig();
      if (input.records.length === 0) {
        return emptySummary(input.session.account, sessionIdValue, 'done');
      }
      if (!config.privacy.enabled) {
        const summary = emptySummary(input.session.account, sessionIdValue, 'failed');
        report(summary);
        return summary;
      }
      if (running.has(sessionIdValue)) return emptySummary(input.session.account, sessionIdValue, 'failed');
      const ownerRecords = input.records.filter((record) => !record.isSelf && record.senderId === input.session.peer);
      if (ownerRecords.length === 0) return emptySummary(input.session.account, sessionIdValue, 'done');
      const newestMessageTime = ownerRecords.reduce((latest, record) => Math.max(latest, record.time), 0);
      const latest = ownerRecords.at(-1)!;
      const extractionInput: ExtractInput = {
        session: input.session,
        messageId: latest.messageId,
        senderId: input.session.peer,
        now: input.now,
        template: input.template,
      };
      if (budgetState(config, options.repository.costToday()) === 'exceeded') {
        const summary = emptySummary(input.session.account, sessionIdValue, 'budget');
        report(summary);
        return summary;
      }
      running.add(sessionIdValue);
      try {
        return await runExtraction(extractionInput, sessionIdValue, config, input.records, newestMessageTime);
      } catch {
        reportError(input.session.account, sessionIdValue);
        const summary = emptySummary(input.session.account, sessionIdValue, 'failed');
        report(summary);
        return summary;
      } finally {
        running.delete(sessionIdValue);
      }
    },

    async idle() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}
