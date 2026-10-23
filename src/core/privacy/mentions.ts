import type OpenAI from 'openai';
import type { AquariumConfig } from '../../config/schema.ts';
import { budgetState } from '../../llm/budget.ts';
import { callSlot } from '../../llm/slots.ts';
import type { PrivateFactMentionEvidence, PrivateFactRecord } from '../../store/privacy-repo.ts';
import type { StoreRepository } from '../../store/repository.ts';
import type { PrivacyMentionPromptTemplate } from '../prompt/templates.ts';
import type { PipelineModelCall } from '../conversation/steps/types.ts';
import { sessionId, type SessionKey } from '../shared/events.ts';
import { decide } from './policy.ts';
import { syncKinRelays } from './kin-relay.ts';

interface MentionInput {
  session: SessionKey;
  senderId: number;
  messageId: string;
  now: number;
  template: PrivacyMentionPromptTemplate;
}

export interface PrivateMentionSummary {
  account: number;
  sessionId: string;
  factId: number;
  mentions: number;
  level: PrivateFactRecord['level'];
}

export interface PrivateMentionService {
  maybePromote(input: MentionInput): void;
  idle(): Promise<void>;
}

export interface PrivateMentionServiceOptions {
  repository: StoreRepository;
  getConfig: () => AquariumConfig;
  callModel?: PipelineModelCall;
  now?: () => number;
  onMention?: (summary: PrivateMentionSummary) => void;
  onError?: (context: { account: number; sessionId: string }) => void;
}

function localDayRange(time: number): { start: number; end: number } {
  const start = new Date(time);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start: start.getTime(), end: end.getTime() };
}

function mentionsAlreadyRecorded(
  fact: PrivateFactRecord,
  messageId: string,
  start: number,
  end: number,
): boolean {
  return fact.mentionEvidence.some((entry) => entry.messageId === messageId
    || (entry.time >= start && entry.time < end));
}

function parseMentionIds(text: string, allowed: ReadonlySet<number>): number[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const mentions = (parsed as Record<string, unknown>).mentions;
  if (!Array.isArray(mentions)) return undefined;
  const ids: number[] = [];
  for (const value of mentions) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || !allowed.has(value)) {
      return undefined;
    }
    if (!ids.includes(value)) ids.push(value);
  }
  return ids;
}

function buildMentionMessages(
  message: string,
  facts: readonly PrivateFactRecord[],
  template: PrivacyMentionPromptTemplate,
): OpenAI.ChatCompletionMessageParam[] {
  return [
    { role: 'system', content: template.system },
    {
      role: 'user',
      content: template.user
        .replaceAll('{{message}}', message)
        .replaceAll('{{facts}}', facts.map((fact) => `#${fact.id} ${fact.text}`).join('\n')),
    },
  ];
}

function allowedForGate(fact: PrivateFactRecord, session: SessionKey): boolean {
  return decide({
    info: { origin: 'private', sessionId: fact.sessionId, ownerId: fact.ownerId, level: fact.level },
    target: { kind: 'group', sessionId: sessionId(session) },
    purpose: 'gate',
  }) === 'gate_only';
}

export function createPrivacyMentionService(options: PrivateMentionServiceOptions): PrivateMentionService {
  const pending = new Set<Promise<void>>();
  const callModel = options.callModel ?? callSlot;
  const currentTime = options.now ?? Date.now;

  function reportError(account: number, groupSessionId: string): void {
    try {
      options.onError?.({ account, sessionId: groupSessionId });
    } catch {
      // 失败上报不能包含群聊或私聊文本，也不能影响消息处理。
    }
  }

  function reportMention(summary: PrivateMentionSummary): void {
    try {
      options.onMention?.(summary);
    } catch {
      // 日志失败不能回滚已经保存的提及证据。
    }
  }

  async function process(input: MentionInput): Promise<void> {
    if (input.session.kind !== 'group' || !Number.isSafeInteger(input.senderId) || input.senderId <= 0
      || input.senderId === input.session.account || input.messageId.length === 0 || !Number.isFinite(input.now)) return;
    const groupSessionId = sessionId(input.session);
    try {
      const config = options.getConfig();
      if (!config.privacy.enabled) return;
      const message = options.repository.messageBySessionAndId(groupSessionId, input.messageId);
      if (!message || message.isSelf || message.senderId !== input.senderId) return;

      const { start: dayStart, end: nextDayStart } = localDayRange(message.time);
      const candidates = options.repository.listPrivateFactsForOwner(input.session.account, input.senderId)
        .filter((fact) => fact.ownerId === input.senderId
          && allowedForGate(fact, input.session)
          && !mentionsAlreadyRecorded(fact, message.messageId, dayStart, nextDayStart)
          && fact.keywords.some((keyword) => message.plainText.toLocaleLowerCase().includes(keyword.trim().toLocaleLowerCase())));
      if (candidates.length === 0 || budgetState(config, options.repository.costToday()) === 'exceeded') return;

      let responseText: string;
      try {
        const response = await callModel('judge', buildMentionMessages(message.plainText, candidates, input.template), {
          config,
          account: input.session.account,
          costToday: () => options.repository.costToday(),
          recordUsage: options.repository.recordUsage,
          now: () => input.now,
        });
        responseText = response.text;
      } catch {
        reportError(input.session.account, groupSessionId);
        return;
      }

      const mentionedIds = parseMentionIds(responseText, new Set(candidates.map((fact) => fact.id)));
      if (!mentionedIds || mentionedIds.length === 0) return;
      const completedAt = currentTime();
      if (!Number.isFinite(completedAt)) return;
      const byId = new Map(candidates.map((fact) => [fact.id, fact]));
      for (const factId of mentionedIds) {
        const fact = byId.get(factId);
        if (!fact) continue;
        const evidence: PrivateFactMentionEvidence = {
          sessionId: groupSessionId,
          messageId: message.messageId,
          time: message.time,
        };
        const saved = options.repository.recordPrivateFactMention({
          account: input.session.account,
          ownerId: input.senderId,
          id: factId,
          evidence,
          dayStart,
          nextDayStart,
          updatedAt: completedAt,
          promoteMentions: config.privacy.promoteMentions,
        });
        if (saved.recorded && saved.fact) {
          if (saved.fact.level !== fact.level) {
            try {
              syncKinRelays(options.repository, completedAt);
            } catch {
              reportError(input.session.account, groupSessionId);
            }
          }
          reportMention({
            account: input.session.account,
            sessionId: groupSessionId,
            factId,
            mentions: saved.fact.mentions,
            level: saved.fact.level,
          });
        }
      }
    } catch {
      reportError(input.session.account, groupSessionId);
    }
  }

  return {
    maybePromote(input) {
      const task = process(input);
      pending.add(task);
      void task.finally(() => pending.delete(task));
    },
    async idle() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}
