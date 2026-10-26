import type { AquariumConfig } from '../config/schema.ts';
import type { MessageStorageRecord, StoreRepository } from '../store/repository.ts';
import type { PersonaEventMemoRecord } from '../store/persona-memory-event-repo.ts';
import type { PersonaDiarySourceEntry } from '../store/persona-memory-repo.ts';
import { sessionId, type IncomingMessage, type SessionKey } from './shared/events.ts';
import { createRecentDiaryBlock, createRecentSleepMemoryBlock } from './persona-memory-prompt.ts';
import { segmentMemoryMessages } from './persona-memory-segments.ts';
import { organizePersonaMemoryAtSleep } from './persona-memory-organize.ts';
import { organizePersonaMemoryAtWake, type PersonaMemoryWakeInput, type PersonaMemoryWakeResult } from './persona-memory-wake.ts';

export { segmentMemoryMessages } from './persona-memory-segments.ts';

const WAKE_WORD_QUIET_MS = 10 * 60_000;
const WAKE_WORD_TTL_MS = 6 * 60 * 60_000;

export type PersonaMemoryProcessStatus = 'done' | 'budget' | 'failed';

export interface PersonaMemoryProcessResult {
  status: PersonaMemoryProcessStatus;
  memos?: Array<Parameters<StoreRepository['insertPersonaEventMemo']>[0]>;
}

export interface PersonaMemoryDiaryGenerationInput {
  account: number;
  cycleKey: string;
  now: number;
  memos: PersonaEventMemoRecord[];
  tailEntries: PersonaDiarySourceEntry[];
}

export type PersonaMemoryDiaryGenerationResult =
  | { status: 'done'; text: string }
  | { status: 'budget' | 'failed' };

export interface PersonaMemoryServiceOptions {
  repository: StoreRepository;
  getConfig: () => AquariumConfig;
  canProcessSession?: (session: SessionKey) => boolean;
  processSession: (
    session: SessionKey,
    records: MessageStorageRecord[],
    now: number,
  ) => Promise<PersonaMemoryProcessStatus | PersonaMemoryProcessResult>;
  isSignificantSegment?: (session: SessionKey, records: MessageStorageRecord[]) => boolean;
  generateDiary?: (input: PersonaMemoryDiaryGenerationInput) => Promise<PersonaMemoryDiaryGenerationResult>;
  onError?: (error: unknown, account: number) => void;
}

export interface PersonaMemoryOrganizeInput {
  account: number;
  cycleKey: string;
  now: number;
  skipDiary?: boolean;
}

export interface PersonaMemoryOrganizeResult extends PersonaMemoryOrganizeInput {
  status: 'done' | 'budget' | 'failed' | 'partial' | 'empty' | 'already_run';
  memoCount: number;
  processedCount: number;
}

export interface PersonaMemoryWakeWordScheduleInput {
  session: SessionKey;
  cycleKey: string;
  wakeMessageId: string;
  bedAt: number;
  wakeAt: number;
  now: number;
}

export interface PersonaMemoryService {
  observeMessage(message: IncomingMessage): boolean;
  organizeAtSleep(input: PersonaMemoryOrganizeInput): Promise<PersonaMemoryOrganizeResult>;
  organizeAtWake(input: PersonaMemoryWakeInput): Promise<PersonaMemoryWakeResult>;
  scheduleWakeWordBacklog(input: PersonaMemoryWakeWordScheduleInput): boolean;
  recentDiaryBlock(account: number, session: SessionKey, now: number): string | undefined;
  sleepMemoryBlock(account: number, session: SessionKey, now: number): string | undefined;
}

function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const previous = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
  return text.slice(0, end);
}

export function createPersonaMemoryService(options: PersonaMemoryServiceOptions): PersonaMemoryService {
  function reportError(error: unknown, account: number): void {
    try {
      options.onError?.(error, account);
    } catch {
      // 记录失败不能影响回复或调度器。
    }
  }
  const activeRuns = new Set<string>();
  const recentDiaryBlock = createRecentDiaryBlock(options.repository, truncateText);
  const sleepMemoryBlock = createRecentSleepMemoryBlock(options.repository, truncateText);

  return {
    observeMessage(message) {
      const account = message.session.account;
      if (!Number.isSafeInteger(account) || account <= 0
        || typeof message.messageId !== 'string' || message.messageId.length < 1 || message.messageId.length > 512
        || !Number.isSafeInteger(message.time) || message.time < 0) return false;
      try {
        const targetSessionId = sessionId(message.session);
        const cursor = options.repository.personaMemoryCursor(account, targetSessionId);
        const pendingMessages = options.repository.listPersonaMemoryPendingMessages(account, targetSessionId);
        const segments = segmentMemoryMessages({
          sessionKind: message.session.kind,
          messages: pendingMessages,
          now: message.time,
        });
        const openSegment = segments.findLast((segment) => !segment.closed);
        options.repository.savePersonaMemoryCursor({
          account,
          sessionId: targetSessionId,
          organizedUntilMessageTime: cursor?.organizedUntilMessageTime ?? null,
          organizedUntilMessageRowId: cursor?.organizedUntilMessageRowId ?? null,
          openSegmentStart: openSegment?.startAt ?? null,
        });
      } catch (error) {
        reportError(error, account);
        return false;
      }
      return true;
    },

    async organizeAtSleep(input) {
      return organizePersonaMemoryAtSleep(options, activeRuns, input);
    },

    async organizeAtWake(input) {
      return organizePersonaMemoryAtWake(options, activeRuns, input);
    },

    scheduleWakeWordBacklog(input) {
      const { session } = input;
      const account = session.account;
      if (!Number.isSafeInteger(account) || account <= 0 || !/^\d{4}-\d{2}-\d{2}$/u.test(input.cycleKey)
        || typeof input.wakeMessageId !== 'string' || input.wakeMessageId.length < 1 || input.wakeMessageId.length > 512
        || !Number.isSafeInteger(input.bedAt) || input.bedAt < 0
        || !Number.isSafeInteger(input.wakeAt) || input.wakeAt <= input.bedAt
        || !Number.isSafeInteger(input.now) || input.now < input.bedAt || input.now >= input.wakeAt) return false;
      try {
        const targetSessionId = sessionId(session);
        const pending = options.repository.listPersonaMemoryPendingMessages(account, targetSessionId)
          .filter((message) => message.time >= input.bedAt && message.time <= input.now);
        const wakeIndex = pending.findIndex((message) => message.messageId === input.wakeMessageId);
        if (wakeIndex < 0) return false;
        const segments = segmentMemoryMessages({
          sessionKind: session.kind,
          messages: pending.map((message, rowId) => ({
            messageId: message.messageId,
            rowId: rowId + 1,
            time: message.time,
            senderId: message.senderId,
            isSelf: message.isSelf,
            plainText: message.plainText,
          })),
          now: input.now,
          forceClose: true,
        });
        const recentSegment = segments.findLast((segment) => segment.messages.some(
          (message) => message.messageId === input.wakeMessageId,
        ));
        const segmentStartId = recentSegment?.messages[0]?.messageId;
        const segmentStartIndex = segmentStartId === undefined
          ? -1
          : pending.findIndex((message) => message.messageId === segmentStartId);
        if (segmentStartIndex < 0 || segmentStartIndex <= 20) return false;
        const messageIds = pending.slice(0, segmentStartIndex - 20)
          .filter((message) => !message.isSelf && message.senderId !== account)
          .map(({ messageId }) => messageId);
        if (messageIds.length === 0) return false;
        return options.repository.enqueuePersonaMemoryWakeWordJob({
          account,
          sessionId: targetSessionId,
          cycleKey: input.cycleKey,
          wakeMessageId: input.wakeMessageId,
          bedAt: input.bedAt,
          wakeAt: input.wakeAt,
          messageIds,
          createdAt: input.now,
          nextAttemptAt: input.now + WAKE_WORD_QUIET_MS,
          expiresAt: input.now + WAKE_WORD_TTL_MS,
        });
      } catch (error) {
        reportError(error, account);
        return false;
      }
    },

    recentDiaryBlock,
    sleepMemoryBlock,
  };
}
