import type { AquariumConfig } from '../config/schema.ts';
import { canCallWithDailyBudget, isBudgetExceededError } from '../llm/budget.ts';
import type { MessageStorageRecord, StoreRepository } from '../store/repository.ts';
import type { PersonaDiarySourceEntry } from '../store/persona-memory-repo.ts';
import { sessionId, type IncomingMessage, type SessionKey } from './shared/events.ts';
import { parseSessionId } from './conversation/sessions.ts';
import { redactSensitiveText } from './impressions/sensitive-text.ts';
import { createRecentDiaryBlock, DIARY_ENTRY_LIMIT } from './persona-memory-prompt.ts';

export type PersonaMemoryProcessStatus = 'done' | 'budget' | 'failed';

export interface PersonaMemoryServiceOptions {
  repository: StoreRepository;
  getConfig: () => AquariumConfig;
  canProcessSession?: (session: SessionKey) => boolean;
  processSession: (
    session: SessionKey,
    records: MessageStorageRecord[],
    now: number,
  ) => Promise<PersonaMemoryProcessStatus>;
  onError?: (error: unknown, account: number) => void;
}

export interface PersonaMemoryOrganizeInput {
  account: number;
  cycleKey: string;
  now: number;
}

export interface PersonaMemoryOrganizeResult extends PersonaMemoryOrganizeInput {
  status: 'done' | 'budget' | 'failed' | 'partial' | 'empty' | 'already_run';
  memoCount: number;
  processedCount: number;
}

export interface PersonaMemoryService {
  recordMemo(message: IncomingMessage): boolean;
  organizeAtSleep(input: PersonaMemoryOrganizeInput): Promise<PersonaMemoryOrganizeResult>;
  recentDiaryBlock(account: number, session: SessionKey, now: number): string | undefined;
}

const MEMO_BATCH_LIMIT = 1_000;

function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const previous = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
  return text.slice(0, end);
}

function diaryText(entries: readonly PersonaDiarySourceEntry[]): string {
  const lines = entries.slice(-DIARY_ENTRY_LIMIT).map((entry) => {
    const date = new Date(entry.createdAt);
    const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    return `[${time}] ${JSON.stringify(redactSensitiveText(entry.senderName))}：${redactSensitiveText(entry.text)}`;
  });
  return truncateText(`今天的回忆（${entries.length} 条记录）：\n${lines.join('\n')}`, 4_000);
}

function preservedDiaryPrefix(diary: { text: string; sourceEntries: PersonaDiarySourceEntry[] }): string {
  const generatedText = diaryText(diary.sourceEntries);
  if (diary.text === generatedText) return '';
  const generatedSuffix = `\n${generatedText}`;
  return diary.text.endsWith(generatedSuffix)
    ? diary.text.slice(0, -generatedSuffix.length)
    : diary.text;
}

function mergeDiarySourceEntries(
  previous: readonly PersonaDiarySourceEntry[],
  incoming: readonly PersonaDiarySourceEntry[],
): PersonaDiarySourceEntry[] {
  const entries = new Map<string, PersonaDiarySourceEntry>();
  for (const entry of [...previous, ...incoming]) {
    const key = JSON.stringify([entry.sessionId, entry.messageId]);
    if (!entries.has(key)) entries.set(key, entry);
  }
  return [...entries.values()].sort((first, second) => first.createdAt - second.createdAt
    || first.sessionId.localeCompare(second.sessionId)
    || first.messageId.localeCompare(second.messageId));
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

  return {
    recordMemo(message) {
      const text = truncateText(redactSensitiveText(message.plainText.trim()), 2_000);
      const senderName = truncateText(redactSensitiveText(message.senderName.trim() || String(message.senderId)), 120);
      if (text.length === 0 || !Number.isSafeInteger(message.time) || message.time < 0) return false;
      try {
        return options.repository.insertPersonaMemo({
          account: message.session.account,
          sessionId: sessionId(message.session),
          messageId: message.messageId,
          senderId: message.senderId,
          senderName,
          isSelf: message.senderId === message.session.account,
          text,
          createdAt: message.time,
        });
      } catch (error) {
        reportError(error, message.session.account);
        return false;
      }
    },

    async organizeAtSleep(input) {
      const { account, cycleKey, now } = input;
      if (!Number.isSafeInteger(account) || account <= 0 || !/^\d{4}-\d{2}-\d{2}$/u.test(cycleKey)
        || !Number.isSafeInteger(now) || now < 0) {
        throw new RangeError('人格记忆整理参数无效');
      }
      const inputBase = { account, cycleKey, now };
      const runKey = `${account}:${cycleKey}`;
      if (activeRuns.has(runKey)) {
        const activeRun = options.repository.personaMemoryRun(account, cycleKey);
        return {
          ...inputBase,
          status: 'already_run',
          memoCount: activeRun?.memoCount ?? 0,
          processedCount: activeRun?.processedCount ?? 0,
        };
      }
      activeRuns.add(runKey);
      try {
      const existingRun = options.repository.personaMemoryRun(account, cycleKey);
      if (existingRun && existingRun.status !== 'running') {
        return {
          ...inputBase,
          status: 'already_run',
          memoCount: existingRun.memoCount,
          processedCount: existingRun.processedCount,
        };
      }

      const recoveredCount = existingRun
        ? options.repository.countProcessedPersonaMemos(account, cycleKey)
        : 0;
      const remainingCapacity = Math.max(0, MEMO_BATCH_LIMIT - recoveredCount);
      const pendingMemos = options.repository.listPendingPersonaMemos(account, remainingCapacity + 1);
      const backlogRemains = pendingMemos.length > remainingCapacity;
      const memos = pendingMemos.slice(0, remainingCapacity);
      const observedMemoCount = recoveredCount + pendingMemos.length;
      const resumeOrStartSucceeded = existingRun
        ? options.repository.resumePersonaMemoryRun({
          account,
          cycleKey,
          memoCount: observedMemoCount,
          processedCount: recoveredCount,
        })
        : options.repository.startPersonaMemoryRun({ account, cycleKey, memoCount: observedMemoCount, startedAt: now });
      if (!resumeOrStartSucceeded) {
        return { ...inputBase, status: 'already_run', memoCount: observedMemoCount, processedCount: recoveredCount };
      }
      if (memos.length === 0) {
        const status = backlogRemains ? 'partial' : recoveredCount > 0 ? 'done' : 'empty';
        const reason = backlogRemains ? 'memo-backlog-remains' : null;
        options.repository.finishPersonaMemoryRun({
          account, cycleKey, status, reason, processedCount: recoveredCount, finishedAt: now,
        });
        return { ...inputBase, status, memoCount: observedMemoCount, processedCount: recoveredCount };
      }
      if (!canCallWithDailyBudget(options.getConfig(), 'extract', options.repository.costToday())) {
        options.repository.finishPersonaMemoryRun({
          account,
          cycleKey,
          status: 'budget',
          reason: 'budgetState=exceeded',
          processedCount: recoveredCount,
          finishedAt: now,
        });
        return {
          ...inputBase,
          status: 'budget',
          memoCount: observedMemoCount,
          processedCount: recoveredCount,
        };
      }

      const batches = new Map<string, { session: SessionKey; memos: typeof memos }>();
      for (const memo of memos) {
        const session = parseSessionId(memo.sessionId);
        if (!session || session.account !== account) {
          options.repository.finishPersonaMemoryRun({
            account, cycleKey, status: 'failed', reason: 'invalid-session', processedCount: recoveredCount, finishedAt: now,
          });
          return { ...inputBase, status: 'failed', memoCount: observedMemoCount, processedCount: recoveredCount };
        }
        const batch = batches.get(memo.sessionId) ?? { session, memos: [] };
        batch.memos.push(memo);
        batches.set(memo.sessionId, batch);
      }

      let processedCount = recoveredCount;
      const processedMemos: typeof memos = [];
      let status: 'done' | 'budget' | 'failed' | 'partial' = 'done';
      let reason: string | null = null;
      let sessionIssueReason: string | null = null;
      batchLoop: for (const batch of batches.values()) {
        const windowLimit = batch.session.kind === 'private' ? 60 : 80;
        for (let offset = 0; offset < batch.memos.length; offset += windowLimit) {
          let sessionAllowed = true;
          let sessionCheckFailed = false;
          try {
            sessionAllowed = options.canProcessSession?.(batch.session) ?? true;
          } catch (error) {
            reportError(error, account);
            sessionAllowed = false;
            sessionCheckFailed = true;
          }
          if (!sessionAllowed) {
            sessionIssueReason ??= sessionCheckFailed ? 'session-check-failed' : 'session-disabled';
            continue batchLoop;
          }
          if (!canCallWithDailyBudget(options.getConfig(), 'extract', options.repository.costToday())) {
            status = 'budget';
            reason = 'budgetState=exceeded';
            break batchLoop;
          }
          const windowMemos = batch.memos.slice(offset, offset + windowLimit);
          let result: PersonaMemoryProcessStatus;
          try {
            const records: MessageStorageRecord[] = windowMemos.map((memo) => ({
              sessionId: memo.sessionId,
              messageId: memo.messageId,
              senderId: memo.senderId,
              senderName: memo.senderName,
              isSelf: memo.isSelf,
              plainText: memo.text,
              segments: [],
              time: memo.createdAt,
            }));
            result = await options.processSession(batch.session, records, now);
          } catch (error) {
            if (isBudgetExceededError(error)) result = 'budget';
            else {
              reportError(error, account);
              result = 'failed';
            }
          }
          if (result === 'budget') {
            status = 'budget';
            reason = 'budgetState=exceeded';
            break batchLoop;
          }
          if (result === 'failed') {
            sessionIssueReason ??= 'session-organization-failed';
            continue batchLoop;
          }
          processedMemos.push(...windowMemos);
          processedCount += windowMemos.length;
        }
      }

      if (processedMemos.length > 0) {
        try {
          const existingDiary = options.repository.personaDiary(account, cycleKey);
          const sourceEntries = mergeDiarySourceEntries(
            existingDiary?.sourceEntries ?? [],
            processedMemos.map((memo) => ({
              sessionId: memo.sessionId,
              messageId: memo.messageId,
              senderName: memo.senderName,
              text: memo.text,
              createdAt: memo.createdAt,
            })),
          );
          const generatedText = diaryText(sourceEntries);
          const legacyPrefix = existingDiary ? preservedDiaryPrefix(existingDiary) : '';
          options.repository.insertPersonaDiary({
            account,
            cycleKey,
            text: truncateText(legacyPrefix ? `${legacyPrefix}\n${generatedText}` : generatedText, 4_000),
            sourceEntries,
            sourceCount: Math.max(existingDiary?.sourceCount ?? 0, sourceEntries.length),
            createdAt: existingDiary?.createdAt ?? now,
            ...(existingDiary ? { visibleToAni: existingDiary.visibleToAni } : {}),
          });
        } catch (error) {
          reportError(error, account);
          status = 'failed';
          reason = 'diary-write-failed';
          processedCount = recoveredCount;
        }
      }
      if (processedMemos.length > 0 && reason !== 'diary-write-failed') {
        try {
          const marked = options.repository.markPersonaMemosProcessed(
            account,
            processedMemos.map(({ id }) => id),
            cycleKey,
          );
          const totalMarked = options.repository.countProcessedPersonaMemos(account, cycleKey);
          if (marked !== processedMemos.length) {
            status = 'failed';
            reason = 'memo-readback-mismatch';
            processedCount = totalMarked;
          } else {
            processedCount = totalMarked;
          }
        } catch (error) {
          reportError(error, account);
          status = 'failed';
          reason = 'memo-processing-write-failed';
          processedCount = recoveredCount;
        }
      }
      if (status === 'done' && sessionIssueReason !== null) {
        status = processedMemos.length > 0 ? 'partial' : 'failed';
        reason = sessionIssueReason;
      }
      if (status === 'done' && backlogRemains) {
        status = 'partial';
        reason = 'memo-backlog-remains';
      }
      options.repository.finishPersonaMemoryRun({
        account, cycleKey, status, reason, processedCount, finishedAt: now,
      });
      return { ...inputBase, status, memoCount: observedMemoCount, processedCount };
      } finally {
        activeRuns.delete(runKey);
      }
    },

    recentDiaryBlock,
  };
}
