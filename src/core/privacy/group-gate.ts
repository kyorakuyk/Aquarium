import type OpenAI from 'openai';
import type { AquariumConfig } from '../../config/schema.ts';
import { budgetState } from '../../llm/budget.ts';
import { callSlot } from '../../llm/slots.ts';
import type { PrivateFactLevel, PrivateFactRecord } from '../../store/privacy-repo.ts';
import type { MessageStorageRecord, StoreRepository } from '../../store/repository.ts';
import { sessionId, type SessionKey } from '../shared/events.ts';
import { decide } from './policy.ts';
import type { PipelineModelCall } from '../conversation/steps/types.ts';
import type { PrivacyGatePromptTemplate } from '../prompt/templates.ts';

const privacyRule = '群里正在聊的话题可能涉及别人的私事。你对此一无所知，不追问、不展开、不猜测。';
const minuteMs = 60 * 1_000;

export interface PrivacyGateFactRef {
  id: number;
  level: PrivateFactLevel;
}

export interface PrivacyGateDetail {
  prefiltered: PrivacyGateFactRef[];
  touched: PrivacyGateFactRef[];
  injected: PrivacyGateFactRef[];
  judge: 'skipped' | 'judged' | 'fallback_all';
  avoidUntil?: number;
}

export interface PrivacyGateDecision {
  action: 'allow' | 'avoid';
  detail: PrivacyGateDetail;
  knownFacts?: string;
  privateRule?: string;
  suppressDebugTrace: boolean;
}

export interface PrivacyGateService {
  activeAvoid(input: { session: SessionKey; now: number }): PrivacyGateDecision | undefined;
  evaluateGroup(input: {
    session: SessionKey;
    senderId: number;
    triggered: boolean;
    now: number;
    messages: MessageStorageRecord[];
    template: PrivacyGatePromptTemplate;
    knownFactsTemplate: string;
  }): Promise<PrivacyGateDecision>;
  checkEgress(input: { session: SessionKey; text: string }): { blocked: boolean; factId?: number; level?: 'L0' };
}

export interface PrivacyGateServiceOptions {
  repository: StoreRepository;
  getConfig: () => AquariumConfig;
  callModel?: PipelineModelCall;
  onError?: (context: { account: number; sessionId: string }) => void;
  onEgress?: (context: { account: number; sessionId: string; factId: number }) => void;
}

interface AvoidEntry {
  until: number;
  detail: PrivacyGateDetail;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function safeFact(fact: PrivateFactRecord): PrivacyGateFactRef {
  return { id: fact.id, level: fact.level };
}

function hasKeyword(text: string, keyword: string): boolean {
  const normalized = keyword.trim().toLocaleLowerCase();
  return normalized.length > 0 && text.toLocaleLowerCase().includes(normalized);
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function formatContext(messages: readonly MessageStorageRecord[]): string {
  return messages.slice(-8).map((message) => {
    const speaker = message.isSelf ? '眷属' : JSON.stringify(message.senderName);
    return `[${formatTime(message.time)}] ${speaker}: ${message.plainText}`;
  }).join('\n');
}

function buildMessages(
  messages: readonly MessageStorageRecord[],
  facts: readonly PrivateFactRecord[],
  template: PrivacyGatePromptTemplate,
): OpenAI.ChatCompletionMessageParam[] {
  const factsText = facts.map((fact) => `#${fact.id} ${fact.text}`).join('\n');
  return [
    { role: 'system', content: template.system },
    {
      role: 'user',
      content: template.user
        .replaceAll('{{context}}', formatContext(messages))
        .replaceAll('{{facts}}', factsText),
    },
  ];
}

function parseTouches(text: string, allowedIds: ReadonlySet<number>): number[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const record = asRecord(parsed);
  if (!record || !Array.isArray(record.touches)) return undefined;
  const ids: number[] = [];
  for (const value of record.touches) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || !allowedIds.has(value)) {
      return undefined;
    }
    if (!ids.includes(value)) ids.push(value);
  }
  return ids;
}

function emptyDetail(): PrivacyGateDetail {
  return { prefiltered: [], touched: [], injected: [], judge: 'skipped' };
}

function allowedForPurpose(fact: PrivateFactRecord, session: SessionKey, purpose: 'gate' | 'prompt' | 'third_party'): boolean {
  return decide({
    info: { origin: 'private', sessionId: fact.sessionId, ownerId: fact.ownerId, level: fact.level },
    target: { kind: 'group', sessionId: sessionId(session) },
    purpose,
  }) === (purpose === 'gate' ? 'gate_only' : purpose === 'prompt' ? 'allow' : 'deny');
}

export function createPrivacyGateService(options: PrivacyGateServiceOptions): PrivacyGateService {
  const avoidUntilBySession = new Map<string, AvoidEntry>();
  const callModel = options.callModel ?? callSlot;

  function reportError(account: number, currentSessionId: string): void {
    try {
      options.onError?.({ account, sessionId: currentSessionId });
    } catch {
      // 错误上报不能记录私聊文本或中断守门。
    }
  }

  function avoidDecision(detail: PrivacyGateDetail, until?: number): PrivacyGateDecision {
    return {
      action: 'avoid',
      detail: until === undefined ? detail : { ...detail, avoidUntil: until },
      suppressDebugTrace: true,
    };
  }

  function activeAvoid(input: { session: SessionKey; now: number }): PrivacyGateDecision | undefined {
    if (input.session.kind !== 'group' || !options.getConfig().privacy.enabled) return undefined;
    const currentSessionId = sessionId(input.session);
    const activeAvoid = avoidUntilBySession.get(currentSessionId);
    if (!activeAvoid) return undefined;
    if (input.now >= activeAvoid.until) {
      avoidUntilBySession.delete(currentSessionId);
      return undefined;
    }
    return avoidDecision(activeAvoid.detail, activeAvoid.until);
  }

  async function evaluateGroup(input: {
    session: SessionKey;
    senderId: number;
    triggered: boolean;
    now: number;
    messages: MessageStorageRecord[];
    template: PrivacyGatePromptTemplate;
    knownFactsTemplate: string;
  }): Promise<PrivacyGateDecision> {
    if (input.session.kind !== 'group') return { action: 'allow', detail: emptyDetail(), suppressDebugTrace: false };
    const currentSessionId = sessionId(input.session);
    const config = options.getConfig();
    if (!config.privacy.enabled) return { action: 'allow', detail: emptyDetail(), suppressDebugTrace: false };

    const activeAvoid = avoidUntilBySession.get(currentSessionId);
    if (!input.triggered && activeAvoid) {
      if (input.now < activeAvoid.until) return avoidDecision(activeAvoid.detail, activeAvoid.until);
      avoidUntilBySession.delete(currentSessionId);
    }

    try {
      const allFacts = options.repository.listPrivateFactsForGroup(input.session.account, currentSessionId)
        .filter((fact) => allowedForPurpose(fact, input.session, 'gate'));
      const context = input.messages.slice(-8);
      const searchableText = context.map((message) => message.plainText).join('\n').toLocaleLowerCase();
      const prefiltered = allFacts.filter((fact) => fact.keywords.some((keyword) => hasKeyword(searchableText, keyword)));
      let touched = [] as PrivateFactRecord[];
      let judge: PrivacyGateDetail['judge'] = 'skipped';

      if (prefiltered.length > 0) {
        const ids = new Set(prefiltered.map((fact) => fact.id));
        const overBudget = budgetState(config, options.repository.costToday()) === 'exceeded';
        if (overBudget) {
          touched = prefiltered;
          judge = 'fallback_all';
        } else {
          try {
            const response = await callModel('judge', buildMessages(context, prefiltered, input.template), {
              config,
              account: input.session.account,
              costToday: () => options.repository.costToday(),
              recordUsage: options.repository.recordUsage,
              now: () => input.now,
            });
            const touches = parseTouches(response.text, ids);
            if (touches === undefined) {
              touched = prefiltered;
              judge = 'fallback_all';
            } else {
              const touchedIds = new Set(touches);
              touched = prefiltered.filter((fact) => touchedIds.has(fact.id));
              judge = 'judged';
            }
          } catch {
            touched = prefiltered;
            judge = 'fallback_all';
            reportError(input.session.account, currentSessionId);
          }
        }
      }

      const detail: PrivacyGateDetail = {
        prefiltered: prefiltered.map(safeFact),
        touched: touched.map(safeFact),
        injected: [],
        judge,
      };
      const touchedL0 = touched.filter((fact) => fact.level === 'L0');
      if (touchedL0.length > 0 && !input.triggered) {
        const until = input.now + config.privacy.avoidMinutes * minuteMs;
        const avoidDetail = { ...detail, touched: touchedL0.map(safeFact), avoidUntil: until };
        avoidUntilBySession.set(currentSessionId, { until, detail: avoidDetail });
        return avoidDecision(avoidDetail, until);
      }
      if (touchedL0.length > 0) {
        return {
          action: 'allow',
          detail,
          privateRule: privacyRule,
          suppressDebugTrace: true,
        };
      }

      const touchedPromptFacts = touched.filter((fact) => fact.level !== 'L0'
        && allowedForPurpose(fact, input.session, 'prompt'));
      const touchedIds = new Set(touched.map((fact) => fact.id));
      const ownerL2 = allFacts.filter((fact) => fact.level === 'L2' && !touchedIds.has(fact.id)
        && fact.ownerId === input.senderId && allowedForPurpose(fact, input.session, 'prompt')).slice(0, 3);
      const knownFacts = [...touchedPromptFacts, ...ownerL2];
      const uniqueKnownFacts = [...new Map(knownFacts.map((fact) => [fact.id, fact])).values()];
      detail.injected = uniqueKnownFacts.map(safeFact);
      const knownFactsBlock = uniqueKnownFacts.length > 0
        ? input.knownFactsTemplate.replaceAll('{{facts}}', uniqueKnownFacts.map((fact) => fact.text).join('；'))
        : undefined;
      return {
        action: 'allow',
        detail,
        ...(knownFactsBlock === undefined ? {} : { knownFacts: knownFactsBlock }),
        suppressDebugTrace: knownFactsBlock !== undefined || prefiltered.some((fact) => fact.level === 'L0'),
      };
    } catch {
      reportError(input.session.account, currentSessionId);
      if (!input.triggered) {
        const detail = { ...emptyDetail(), judge: 'fallback_all' as const };
        const until = input.now + config.privacy.avoidMinutes * minuteMs;
        avoidUntilBySession.set(currentSessionId, { until, detail });
        return avoidDecision(detail, until);
      }
      return {
        action: 'allow',
        detail: { ...emptyDetail(), judge: 'fallback_all' },
        privateRule: privacyRule,
        suppressDebugTrace: true,
      };
    }
  }

  function checkEgress(input: { session: SessionKey; text: string }): { blocked: boolean; factId?: number; level?: 'L0' } {
    if (input.session.kind !== 'group') return { blocked: false };
    const candidates = options.repository.listPrivateFactsForGroup(input.session.account, sessionId(input.session))
      .filter((fact) => fact.level === 'L0' && allowedForPurpose(fact, input.session, 'third_party'));
    const text = input.text.toLocaleLowerCase();
    const match = candidates.find((fact) => fact.keywords.filter((keyword) => hasKeyword(text, keyword)).length >= 2);
    if (!match) return { blocked: false };
    try {
      options.onEgress?.({ account: input.session.account, sessionId: sessionId(input.session), factId: match.id });
    } catch {
      // 告警回调不能影响出口拦截。
    }
    return { blocked: true, factId: match.id, level: 'L0' };
  }

  return { activeAvoid, evaluateGroup, checkEgress };
}
