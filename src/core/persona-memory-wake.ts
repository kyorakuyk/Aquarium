import { resolveSession } from '../config/resolve.ts';
import type { StoreRepository } from '../store/repository.ts';
import type { PersonaDiarySourceEntry } from '../store/persona-memory-repo.ts';
import { parseSessionId } from './conversation/sessions.ts';
import { redactSensitiveText } from './impressions/sensitive-text.ts';
import { organizePersonaMemoryAtSleep } from './persona-memory-organize.ts';
import { decide } from './privacy/policy.ts';
import { type SessionKey } from './shared/events.ts';
import type { PersonaMemoryOrganizeInput, PersonaMemoryOrganizeResult, PersonaMemoryServiceOptions } from './persona-memory.ts';

const SLEEP_CONTEXT_TTL_MS = 6 * 60 * 60_000;

export interface PersonaMemoryWakeInput extends PersonaMemoryOrganizeInput {
  bedAt: number;
  wakeAt: number;
}

export interface PersonaMemoryWakeResult {
  organized: PersonaMemoryOrganizeResult;
  contextCount: number;
  followupCount: number;
}

interface WakeMessage {
  rowId: number;
  messageId: string;
  senderId: number;
  senderName: string;
  isSelf: boolean;
  plainText: string;
  time: number;
  segments: unknown[];
}

interface WakeSessionMessages {
  session: SessionKey;
  messages: WakeMessage[];
  repliedMessageIds: Set<string>;
}

function validInput(input: PersonaMemoryWakeInput): boolean {
  return Number.isSafeInteger(input.account) && input.account > 0
    && /^\d{4}-\d{2}-\d{2}$/u.test(input.cycleKey)
    && Number.isSafeInteger(input.bedAt) && input.bedAt >= 0
    && Number.isSafeInteger(input.wakeAt) && input.wakeAt > input.bedAt
    && Number.isSafeInteger(input.now) && input.now >= input.wakeAt;
}

function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  if (text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff
    && text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) <= 0xdfff) end -= 1;
  return text.slice(0, end);
}

function isAtSelf(segments: readonly unknown[], account: number): boolean {
  return segments.some((segment) => {
    if (typeof segment !== 'object' || segment === null || Array.isArray(segment)) return false;
    const record = segment as Record<string, unknown>;
    return record.type === 'at' && (record.target === account || record.target === String(account));
  });
}

function isAddressed(session: SessionKey, message: WakeMessage, account: number, nicknames: readonly string[]): boolean {
  if (session.kind === 'private') return message.senderId === session.peer;
  return isAtSelf(message.segments, account)
    || nicknames.some((nickname) => nickname.trim().length > 0 && message.plainText.includes(nickname.trim()));
}

function cursorIncludes(
  cursor: ReturnType<StoreRepository['personaMemoryCursor']>,
  message: WakeMessage,
): boolean {
  if (!cursor || cursor.organizedUntilMessageTime === null) return false;
  if (message.time < cursor.organizedUntilMessageTime) return true;
  if (message.time > cursor.organizedUntilMessageTime) return false;
  return cursor.organizedUntilMessageRowId !== null
    && cursor.organizedUntilMessageRowId !== undefined
    && message.rowId <= cursor.organizedUntilMessageRowId;
}

function memoTouchesSleepWindow(
  repository: StoreRepository,
  memo: ReturnType<StoreRepository['listPersonaEventMemos']>[number],
  messages: readonly WakeMessage[],
): boolean {
  const start = repository.messageBySessionAndId(memo.sessionId, memo.startMessageId);
  const end = repository.messageBySessionAndId(memo.sessionId, memo.endMessageId);
  if (!start || !end || end.time < start.time) return false;
  return messages.some((message) => message.time >= start.time && message.time <= end.time);
}

function memoSourceEntry(memo: ReturnType<StoreRepository['listPersonaEventMemos']>[number]): PersonaDiarySourceEntry {
  return {
    sessionId: memo.sessionId,
    messageId: memo.endMessageId,
    senderName: '事件 memo',
    text: truncateText(redactSensitiveText(`${memo.title}：${memo.summary}`), 2_000),
    createdAt: memo.createdAt,
    level: memo.level,
  };
}

export async function organizePersonaMemoryAtWake(
  options: PersonaMemoryServiceOptions,
  activeRuns: Set<string>,
  input: PersonaMemoryWakeInput,
): Promise<PersonaMemoryWakeResult> {
  if (!validInput(input)) throw new RangeError('人格记忆醒来整理参数无效');
  const snapshots = new Map<string, WakeSessionMessages>();
  const config = options.getConfig();

  for (const cursor of options.repository.listPersonaMemoryCursorSummaries(input.account)) {
    const session = parseSessionId(cursor.sessionId);
    if (!session || session.account !== input.account || cursor.pendingMessageCount === 0) continue;
    const pending = options.repository.listPersonaMemoryPendingMessages(input.account, cursor.sessionId)
      .filter((message) => message.time >= input.bedAt && message.time <= input.wakeAt)
      .map((message) => ({
        rowId: message.rowId,
        messageId: message.messageId,
        senderId: message.senderId,
        senderName: message.senderName,
        isSelf: message.isSelf,
        plainText: message.plainText,
        time: message.time,
        segments: message.segments,
      }));
    if (pending.length === 0) continue;
    const repliedMessageIds = new Set(options.repository.decisionsInRange(cursor.sessionId, input.bedAt, input.wakeAt)
      .filter((decision) => decision.replied)
      .map((decision) => decision.messageId));
    snapshots.set(cursor.sessionId, { session, messages: pending, repliedMessageIds });
  }

  const organized = await organizePersonaMemoryAtSleep(options, activeRuns, {
    account: input.account,
    cycleKey: input.cycleKey,
    now: input.now,
    skipDiary: true,
  });
  const processedBySession = new Map<string, WakeMessage[]>();
  for (const [targetSessionId, snapshot] of snapshots) {
    const cursor = options.repository.personaMemoryCursor(input.account, targetSessionId);
    const processed = snapshot.messages.filter((message) => cursorIncludes(cursor, message));
    if (processed.length > 0) processedBySession.set(targetSessionId, processed);
  }

  const entriesBySession = new Map<string, PersonaDiarySourceEntry[]>();
  const memos = options.repository.listPersonaEventMemos(input.account, 10_000);
  for (const memo of memos) {
    const sourceSession = parseSessionId(memo.sessionId);
    const messages = processedBySession.get(memo.sessionId);
    if (memo.account !== input.account || !sourceSession || sourceSession.account !== input.account || !messages
      || !memoTouchesSleepWindow(options.repository, memo, messages)) continue;
    const sourceOwnerId = sourceSession.kind === 'private'
      ? options.repository.mainUserIdFor(input.account, sourceSession.peer)
      : null;
    const allowed = decide({
      info: {
        origin: sourceSession.kind,
        sessionId: memo.sessionId,
        ownerId: sourceOwnerId,
        level: memo.level,
      },
      target: {
        kind: sourceSession.kind,
        sessionId: memo.sessionId,
        peerId: sourceSession.kind === 'private'
          ? options.repository.mainUserIdFor(input.account, sourceSession.peer)
          : sourceSession.peer,
      },
      purpose: 'prompt',
    });
    if (allowed !== 'allow') continue;
    const entries = entriesBySession.get(memo.sessionId) ?? [];
    entries.push(memoSourceEntry(memo));
    entriesBySession.set(memo.sessionId, entries);
  }

  const followupsBySession = new Map<string, { session: SessionKey; messageIds: string[]; mentionIds: number[] }>();
  for (const [targetSessionId, messages] of processedBySession) {
    const snapshot = snapshots.get(targetSessionId);
    if (!snapshot) continue;
    const settings = resolveSession(config, snapshot.session);
    if (!settings.enabled) continue;
    const candidates = messages.filter((message) => !message.isSelf && message.senderId !== input.account
      && !snapshot.repliedMessageIds.has(message.messageId)
      && isAddressed(snapshot.session, message, input.account, settings.nicknames));
    if (candidates.length === 0) continue;
    followupsBySession.set(targetSessionId, {
      session: snapshot.session,
      messageIds: candidates.map(({ messageId }) => messageId),
      mentionIds: snapshot.session.kind === 'group'
        ? [...new Set(candidates.map(({ senderId }) => senderId))]
        : [],
    });
  }

  let contextCount = 0;
  let followupCount = 0;
  options.repository.transaction(() => {
    for (const [targetSessionId, entries] of entriesBySession) {
      const sourceEntries = entries.sort((first, second) => second.createdAt - first.createdAt
        || second.messageId.localeCompare(first.messageId)).slice(0, 5);
      if (sourceEntries.length === 0) continue;
      options.repository.upsertPersonaMemorySleepContext({
        account: input.account,
        sessionId: targetSessionId,
        cycleKey: input.cycleKey,
        sourceEntries,
        createdAt: input.now,
        expiresAt: input.now + SLEEP_CONTEXT_TTL_MS,
      });
      contextCount += 1;
    }
    for (const [targetSessionId, followup] of followupsBySession) {
      options.repository.enqueuePersonaMemoryWakeFollowup({
        account: input.account,
        sessionId: targetSessionId,
        cycleKey: input.cycleKey,
        messageIds: followup.messageIds,
        mentionIds: followup.mentionIds,
        createdAt: input.now,
        expiresAt: input.now + SLEEP_CONTEXT_TTL_MS,
      });
      followupCount += 1;
    }
  });
  return { organized, contextCount, followupCount };
}
