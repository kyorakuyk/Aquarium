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

export interface PersonaMemoryService {
  observeMessage(message: IncomingMessage): boolean;
  organizeAtSleep(input: PersonaMemoryOrganizeInput): Promise<PersonaMemoryOrganizeResult>;
  organizeAtWake(input: PersonaMemoryWakeInput): Promise<PersonaMemoryWakeResult>;
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

    recentDiaryBlock,
    sleepMemoryBlock,
  };
}
