import type { AquariumConfig } from '../config/schema.ts';
import { parseSessionId } from './conversation/sessions.ts';
import { canCallWithDailyBudget, isBudgetExceededError } from '../llm/budget.ts';
import type { StoreRepository, MessageStorageRecord } from '../store/repository.ts';
import type { PersonaDiarySourceEntry } from '../store/persona-memory-repo.ts';
import { redactSensitiveText } from './impressions/sensitive-text.ts';
import type {
  PersonaMemoryDiaryGenerationInput,
  PersonaMemoryDiaryGenerationResult,
} from './persona-memory.ts';

const DIARY_MEMO_LIMIT = 1_000;
const DIARY_TAIL_SAMPLE_LIMIT = 40;

export interface PersonaMemoryDiarySources {
  memos: ReturnType<StoreRepository['listUnassignedPersonaEventMemos']>;
  tails: Array<{ sessionId: string; messageId: string }>;
  tailEntries: PersonaDiarySourceEntry[];
  sourceEntries: PersonaDiarySourceEntry[];
}

function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const previous = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
  return text.slice(0, end);
}

export function mergePersonaDiarySourceEntries(
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

function tailEntry(record: MessageStorageRecord): PersonaDiarySourceEntry | undefined {
  const text = truncateText(redactSensitiveText(record.plainText.trim()), 2_000);
  if (!text) return undefined;
  return {
    sessionId: record.sessionId,
    messageId: record.messageId,
    senderName: truncateText(redactSensitiveText(record.senderName.trim() || String(record.senderId)), 120),
    text,
    createdAt: record.time,
    level: 'L0',
  };
}

export function collectPersonaMemoryDiarySources(
  repository: StoreRepository,
  account: number,
  now: number,
): PersonaMemoryDiarySources {
  const memos = repository.listUnassignedPersonaEventMemos(account, 0, now, DIARY_MEMO_LIMIT)
    .filter((memo) => parseSessionId(memo.sessionId)?.account === account);
  const tails: Array<{ sessionId: string; messageId: string }> = [];
  const tailEntries: PersonaDiarySourceEntry[] = [];
  for (const tail of repository.listPersonaMemoryTailMessages(account, DIARY_TAIL_SAMPLE_LIMIT)) {
    if (tail.createdAt > now || parseSessionId(tail.sessionId)?.account !== account) continue;
    const record = repository.messageBySessionAndId(tail.sessionId, tail.messageId);
    if (!record || record.time > now) continue;
    const entry = tailEntry(record);
    if (!entry) continue;
    tails.push({ sessionId: tail.sessionId, messageId: tail.messageId });
    tailEntries.push(entry);
  }
  const memoEntries: PersonaDiarySourceEntry[] = memos.map((memo) => ({
    sessionId: memo.sessionId,
    messageId: memo.startMessageId,
    senderName: '事件 memo',
    text: truncateText(redactSensitiveText(`${memo.title}：${memo.summary}`), 2_000),
    createdAt: memo.createdAt,
    level: memo.level,
  }));
  return {
    memos,
    tails,
    tailEntries,
    sourceEntries: mergePersonaDiarySourceEntries(memoEntries, tailEntries),
  };
}

function reportError(onError: ((error: unknown) => void) | undefined, error: unknown): void {
  try { onError?.(error); } catch { /* 错误回调不能改变日记结果。 */ }
}

export async function generatePersonaMemoryDiary(input: {
  account: number;
  cycleKey: string;
  now: number;
  sources: PersonaMemoryDiarySources;
  repository: StoreRepository;
  getConfig: () => AquariumConfig;
  generate: (input: PersonaMemoryDiaryGenerationInput) => Promise<PersonaMemoryDiaryGenerationResult>;
  onError?: (error: unknown) => void;
}): Promise<'done' | 'budget' | 'failed' | 'empty'> {
  const { account, cycleKey, now, sources, repository } = input;
  if (sources.memos.length === 0 && sources.tails.length === 0) return 'empty';
  if (!canCallWithDailyBudget(input.getConfig(), 'extract', repository.costToday())) return 'budget';

  let generated: PersonaMemoryDiaryGenerationResult;
  try {
    generated = await input.generate({
      account,
      cycleKey,
      now,
      memos: sources.memos,
      tailEntries: sources.tailEntries,
    });
  } catch (error) {
    if (isBudgetExceededError(error)) return 'budget';
    reportError(input.onError, error);
    return 'failed';
  }
  if (generated.status !== 'done' || typeof generated.text !== 'string') {
    return generated.status === 'budget' ? 'budget' : 'failed';
  }
  const text = Array.from(redactSensitiveText(generated.text.trim())).slice(0, 600).join('');
  if (!text) return 'failed';

  try {
    repository.transaction(() => {
      const existing = repository.personaDiary(account, cycleKey);
      const sourceEntries = mergePersonaDiarySourceEntries(existing?.sourceEntries ?? [], sources.sourceEntries);
      const sourceMemoIds = [...new Set([...(existing?.sourceMemoIds ?? []), ...sources.memos.map(({ id }) => id)])]
        .sort((first, second) => first - second);
      repository.insertPersonaDiary({
        account,
        cycleKey,
        text,
        sourceEntries,
        sourceMemoIds,
        sourceCount: Math.max(existing?.sourceCount ?? 0, sourceEntries.length),
        createdAt: existing?.createdAt ?? now,
        ...(existing ? { visibleToAni: existing.visibleToAni } : {}),
      });
      const assignedMemos = repository.assignPersonaEventMemosToDiary(account, sources.memos.map(({ id }) => id), cycleKey);
      if (assignedMemos !== sources.memos.length) throw new Error('日记 memo 来源归属不完整');
      const tailsBySession = new Map<string, string[]>();
      for (const tail of sources.tails) {
        const messageIds = tailsBySession.get(tail.sessionId) ?? [];
        messageIds.push(tail.messageId);
        tailsBySession.set(tail.sessionId, messageIds);
      }
      for (const [sessionId, messageIds] of tailsBySession) {
        const assigned = repository.assignPersonaMemoryTailMessagesToDiary(account, sessionId, messageIds, cycleKey);
        if (assigned !== messageIds.length) throw new Error('日记尾巴来源归属不完整');
      }
    });
    return 'done';
  } catch (error) {
    reportError(input.onError, error);
    return 'failed';
  }
}
