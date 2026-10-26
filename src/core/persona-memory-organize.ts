import type { AquariumConfig } from '../config/schema.ts';
import { canCallWithDailyBudget, isBudgetExceededError } from '../llm/budget.ts';
import type { MessageStorageRecord, StoreRepository } from '../store/repository.ts';
import type { PersonaDiarySourceEntry } from '../store/persona-memory-repo.ts';
import { parseSessionId } from './conversation/sessions.ts';
import { redactSensitiveText } from './impressions/sensitive-text.ts';
import { segmentMemoryMessages } from './persona-memory-segments.ts';
import {
  collectPersonaMemoryDiarySources,
  generatePersonaMemoryDiary,
  mergePersonaDiarySourceEntries,
} from './persona-memory-diary.ts';
import { sessionId, type SessionKey } from './shared/events.ts';
import type {
  PersonaMemoryDiaryGenerationInput,
  PersonaMemoryDiaryGenerationResult,
  PersonaMemoryOrganizeInput,
  PersonaMemoryOrganizeResult,
  PersonaMemoryProcessResult,
  PersonaMemoryProcessStatus,
  PersonaMemoryServiceOptions,
} from './persona-memory.ts';

const DIARY_ENTRY_LIMIT = 12;
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

function diaryEntries(records: readonly MessageStorageRecord[]): PersonaDiarySourceEntry[] {
  return records.map((record) => ({
    sessionId: record.sessionId,
    messageId: record.messageId,
    senderName: truncateText(redactSensitiveText(record.senderName.trim() || String(record.senderId)), 120),
    text: truncateText(redactSensitiveText(record.plainText.trim()), 2_000),
    createdAt: record.time,
  })).filter((entry) => entry.text.length > 0);
}

function processResult(value: PersonaMemoryProcessStatus | PersonaMemoryProcessResult): PersonaMemoryProcessResult {
  return typeof value === 'string' ? { status: value } : value;
}

function totalPendingMessages(repository: StoreRepository, account: number): number {
  return repository.listPersonaMemoryCursorSummaries(account)
    .reduce((total, cursor) => total + cursor.pendingMessageCount, 0);
}

export async function organizePersonaMemoryAtSleep(
  options: PersonaMemoryServiceOptions,
  activeRuns: Set<string>,
  input: PersonaMemoryOrganizeInput,
): Promise<PersonaMemoryOrganizeResult> {
  const { account, cycleKey, now } = input;
  const skipDiary = input.skipDiary === true;
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
    const totalPending = totalPendingMessages(options.repository, account);
    const pendingDiarySources = options.generateDiary && !skipDiary
      ? collectPersonaMemoryDiarySources(options.repository, account, now)
      : undefined;
    const hasPendingDiarySources = (pendingDiarySources?.memos.length ?? 0) > 0
      || (pendingDiarySources?.tails.length ?? 0) > 0;
    if (existingRun && existingRun.status !== 'running' && totalPending === 0 && !hasPendingDiarySources) {
      return {
        ...inputBase,
        status: 'already_run',
        memoCount: existingRun.memoCount,
        processedCount: existingRun.processedCount,
      };
    }

    const recoveredCount = existingRun?.processedCount ?? 0;
    const observedMemoCount = Math.max(existingRun?.memoCount ?? 0, recoveredCount + totalPending);
    const remainingCapacity = Math.max(0, MEMO_BATCH_LIMIT - recoveredCount);
    const runReady = existingRun
      ? options.repository.resumePersonaMemoryRun({
        account,
        cycleKey,
        memoCount: observedMemoCount,
        processedCount: recoveredCount,
      })
      : options.repository.startPersonaMemoryRun({
        account,
        cycleKey,
        memoCount: observedMemoCount,
        startedAt: now,
      });
    if (!runReady) {
      return { ...inputBase, status: 'already_run', memoCount: observedMemoCount, processedCount: recoveredCount };
    }

    if (totalPending === 0 && !hasPendingDiarySources) {
      const status = remainingCapacity === 0 && totalPending > 0
        ? 'partial'
        : recoveredCount > 0 ? 'done' : 'empty';
      const reason = status === 'partial' ? 'memo-backlog-remains' : null;
      options.repository.finishPersonaMemoryRun({
        account, cycleKey, status, reason, processedCount: recoveredCount, finishedAt: now,
      });
      return { ...inputBase, status, memoCount: observedMemoCount, processedCount: recoveredCount };
    }

    let processedCount = recoveredCount;
    let status: 'done' | 'budget' | 'failed' | 'partial' | 'empty' = 'done';
    let reason: string | null = null;
    let sessionIssueReason: string | null = null;
    let diaryGenerated = false;
    let stopProcessing = remainingCapacity === 0 && totalPending > 0;
    if (stopProcessing) {
      status = 'partial';
      reason = 'memo-backlog-remains';
    }
    const cursors = options.repository.listPersonaMemoryCursorSummaries(account);

    for (const cursor of cursors) {
      if (stopProcessing || processedCount - recoveredCount >= remainingCapacity) break;
      if (cursor.pendingMessageCount === 0) continue;
      const session = parseSessionId(cursor.sessionId);
      if (!session || session.account !== account) {
        sessionIssueReason ??= 'invalid-session';
        continue;
      }
      let sessionAllowed = true;
      try {
        sessionAllowed = options.canProcessSession?.(session) ?? true;
      } catch (error) {
        try { options.onError?.(error, account); } catch { /* 错误回调不能中断其他会话。 */ }
        sessionAllowed = false;
        sessionIssueReason ??= 'session-check-failed';
      }
      if (!sessionAllowed) {
        sessionIssueReason ??= 'session-disabled';
        continue;
      }

      const pending = options.repository.listPersonaMemoryPendingMessages(account, cursor.sessionId);
      const records: MessageStorageRecord[] = pending.map((message) => ({
        sessionId: cursor.sessionId,
        messageId: message.messageId,
        senderId: message.senderId,
        senderName: message.senderName,
        isSelf: message.isSelf,
        plainText: message.plainText,
        segments: message.segments,
        time: message.time,
      }));
      const rowIdsByMessageId = new Map(pending.map((message) => [message.messageId, message.rowId]));
      const byMessageId = new Map(records.map((record) => [record.messageId, record]));
      const segments = segmentMemoryMessages({
        sessionKind: session.kind,
        messages: records.map((record) => ({
          ...record,
          rowId: rowIdsByMessageId.get(record.messageId),
        })),
        now,
        forceClose: true,
      });

      for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index]!;
        const segmentRecords = segment.messages.flatMap(({ messageId }) => {
          const record = byMessageId.get(messageId);
          return record ? [record] : [];
        });
        if (segmentRecords.length === 0) continue;
        const capacityLeft = remainingCapacity - (processedCount - recoveredCount);
        if (segmentRecords.length > capacityLeft) {
          status = 'partial';
          reason = 'memo-backlog-remains';
          stopProcessing = true;
          break;
        }

        let significant = true;
        try {
          significant = options.isSignificantSegment?.(session, segmentRecords) ?? true;
        } catch (error) {
          try { options.onError?.(error, account); } catch { /* 错误回调不能中断其他会话。 */ }
          sessionIssueReason ??= 'segment-filter-failed';
          break;
        }

        let memos: Array<Parameters<StoreRepository['insertPersonaEventMemo']>[0]> = [];
        if (significant) {
          if (!canCallWithDailyBudget(options.getConfig(), 'extract', options.repository.costToday())) {
            status = 'budget';
            reason = 'budgetState=exceeded';
            stopProcessing = true;
            break;
          }
          let result: PersonaMemoryProcessResult;
          try {
            result = processResult(await options.processSession(session, segmentRecords, now));
          } catch (error) {
            if (isBudgetExceededError(error)) {
              status = 'budget';
              reason = 'budgetState=exceeded';
              stopProcessing = true;
              break;
            }
            try { options.onError?.(error, account); } catch { /* 错误回调不能中断其他会话。 */ }
            sessionIssueReason ??= 'session-organization-failed';
            break;
          }
          if (result.status === 'budget') {
            status = 'budget';
            reason = 'budgetState=exceeded';
            stopProcessing = true;
            break;
          }
          if (result.status === 'failed') {
            sessionIssueReason ??= 'session-organization-failed';
            break;
          }
          memos = result.memos ?? [];
        }

        const entries = diaryEntries(segmentRecords);
        const nextCursor = {
          account,
          sessionId: cursor.sessionId,
          organizedUntilMessageTime: segment.endAt,
          organizedUntilMessageRowId: segment.messages.at(-1)?.rowId ?? null,
          openSegmentStart: segments[index + 1]?.startAt ?? null,
        };
        const nextProcessedCount = processedCount + segmentRecords.length;
        try {
          options.repository.transaction(() => {
            for (const memo of memos) options.repository.insertPersonaEventMemo(memo);
            if (!significant) {
              options.repository.savePersonaMemoryTailMessages({
                account,
                sessionId: cursor.sessionId,
                messages: segmentRecords.map((record) => ({ messageId: record.messageId, createdAt: record.time })),
              });
            }
            options.repository.savePersonaMemoryCursor(nextCursor);
            if (!skipDiary && !options.generateDiary && entries.length > 0) {
              const existingDiary = options.repository.personaDiary(account, cycleKey);
              const sourceEntries = mergePersonaDiarySourceEntries(existingDiary?.sourceEntries ?? [], entries);
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
            }
            options.repository.resumePersonaMemoryRun({
              account,
              cycleKey,
              memoCount: observedMemoCount,
              processedCount: nextProcessedCount,
            });
          });
        } catch (error) {
          try { options.onError?.(error, account); } catch { /* 错误回调不能替代整理结果。 */ }
          status = 'failed';
          reason = 'memory-write-failed';
          stopProcessing = true;
          break;
        }
        processedCount = nextProcessedCount;
      }
    }

    if (!skipDiary && options.generateDiary && status !== 'budget') {
      const sources = collectPersonaMemoryDiarySources(options.repository, account, now);
      if (sources.memos.length > 0 || sources.tails.length > 0) {
        const diaryStatus = await generatePersonaMemoryDiary({
          account,
          cycleKey,
          now,
          sources,
          repository: options.repository,
          getConfig: options.getConfig,
          generate: options.generateDiary,
          onError: (error) => options.onError?.(error, account),
        });
        if (diaryStatus === 'budget') {
          status = 'budget';
          reason = 'budgetState=exceeded';
        } else if (diaryStatus === 'failed') {
          status = 'failed';
          reason = 'diary-generation-failed';
        } else if (diaryStatus === 'done') {
          diaryGenerated = true;
        }
      }
    }

    const pendingAfter = totalPendingMessages(options.repository, account);
    if (status === 'done' && sessionIssueReason !== null) {
      status = processedCount > recoveredCount || diaryGenerated ? 'partial' : 'failed';
      reason = sessionIssueReason;
    }
    if (status === 'done' && pendingAfter > 0) {
      status = processedCount > recoveredCount || diaryGenerated ? 'partial' : 'failed';
      reason = sessionIssueReason ?? 'memo-backlog-remains';
    }
    if (status === 'done' && processedCount === recoveredCount && !diaryGenerated) {
      status = pendingAfter > 0 ? 'failed' : 'empty';
      reason = pendingAfter > 0 ? sessionIssueReason ?? 'no-processable-segments' : null;
    }
    options.repository.finishPersonaMemoryRun({
      account, cycleKey, status, reason, processedCount, finishedAt: now,
    });
    return { ...inputBase, status, memoCount: observedMemoCount, processedCount };
  } finally {
    activeRuns.delete(runKey);
  }
}
