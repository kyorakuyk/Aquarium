import type { SessionKey } from '../shared/events.ts';
import { sessionId } from '../shared/events.ts';
import type { ExistingEventNoteSummary } from './extract.ts';
import { decide } from './policy.ts';
import type {
  EventNoteIntent,
  EventNoteLevel,
  GroupEventNoteInput,
  StoreRepository,
  StoredGroupEventNote,
} from '../../store/repository.ts';
import type { MessageStorageRecord } from '../../store/repository.ts';
import type { ReplySystemTemplate } from '../prompt/templates.ts';
import { redactSensitiveText } from '../impressions/sensitive-text.ts';
import { syncEventAdvocacyForNote } from './event-advocacy.ts';
import {
  groupEventKeywords,
  selectMemberVisibleGroupEvents,
  type PrivateGroupEventCandidate,
} from '../impressions/group-events-prompt.ts';

const EVENT_NOTE_TEXT_MAX = 200;
const MAX_EVENT_NOTE_EVIDENCE = 5;
const GROUP_EVENT_LOOKBACK_MS = 48 * 60 * 60_000;
const MAX_GROUP_EVENTS_IN_PROMPT = 3;
const MAX_GROUP_EVENT_NOTES_IN_PROMPT = 3;
const REVOCATION_TARGET = /(?:说出去|告诉(?:别人|大家|群里)|(?:跟|向)(?:别人|大家|群里)说|(?:在|到)群里说)/u;
const REVOCATION_LEAD = /(?:别|不要|不许|千万别)/u;
const GLOBAL_REVOCATION = /(?:所有|全部|任何(?:事|注解)|以后(?:都)?)/u;

export interface PrivateEventNoteExtractionContext {
  ownerId: number;
  events: PrivateGroupEventCandidate[];
  existingNotes: StoredGroupEventNote[];
  existingNoteSummaries: ExistingEventNoteSummary[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function noteIntent(value: unknown): value is EventNoteIntent {
  return value === 'confide' || value === 'clarify' || value === 'advocate';
}

function levelForIntent(intent: EventNoteIntent): EventNoteLevel {
  return intent === 'confide' ? 'L0' : intent === 'clarify' ? 'L1' : 'L2';
}

function boundedText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = redactSensitiveText(value.trim());
  const length = Array.from(text).length;
  return length >= 4 && length <= EVENT_NOTE_TEXT_MAX ? text : undefined;
}

export function explicitEventNoteRevocation(value: string): boolean {
  const text = value.normalize('NFKC').replace(/\s+/gu, '');
  return REVOCATION_LEAD.test(text) && REVOCATION_TARGET.test(text);
}

function keywordOverlap(first: ReadonlySet<string>, second: ReadonlySet<string>): number {
  let count = 0;
  for (const keyword of first) if (second.has(keyword)) count += 1;
  return count;
}

function revocationTargets(input: {
  repository: StoreRepository;
  account: number;
  sourceSessionId: string;
  text: string;
  notes: readonly StoredGroupEventNote[];
}): StoredGroupEventNote[] {
  if (input.notes.length <= 1 || GLOBAL_REVOCATION.test(input.text)) return [...input.notes];
  const recent = input.repository.recentMessages(input.sourceSessionId, 12);
  const recentIds = new Set(recent.map(({ messageId }) => messageId));
  const currentKeywords = groupEventKeywords(input.text);
  const contextKeywords = groupEventKeywords(recent.map(({ plainText }) => plainText).join('\n'));
  const ranked = input.notes.map((note) => {
    const event = input.repository.getGroupEvent(input.account, note.eventId);
    if (!event) return { note, score: 0 };
    const eventKeywords = groupEventKeywords(`${event.title} ${event.summary} ${note.text}`);
    const currentMatch = keywordOverlap(currentKeywords, eventKeywords);
    const contextMatch = keywordOverlap(contextKeywords, eventKeywords);
    const recentEvidence = note.sourceSessionId === input.sourceSessionId
      && note.sourceMessageIds.some((messageId) => recentIds.has(messageId));
    return { note, score: currentMatch * 100 + contextMatch + (recentEvidence ? 2 : 0) };
  }).sort((first, second) => second.score - first.score);
  const best = ranked[0];
  if (!best || best.score <= 0 || ranked[1]?.score === best.score) return [];
  return [best.note];
}

function privateTarget(targetSessionId: string, ownerId: number) {
  return { kind: 'private' as const, sessionId: targetSessionId, peerId: ownerId };
}

function noteForPrivatePrompt(
  repository: StoreRepository,
  note: StoredGroupEventNote,
  account: number,
  ownerId: number,
  targetSessionId: string,
): boolean {
  return decide({
    info: {
      origin: 'private',
      sessionId: note.sourceSessionId,
      ownerId: repository.mainUserIdFor(account, note.ownerId),
      level: note.level,
      eventIntent: note.intent,
    },
    target: privateTarget(targetSessionId, ownerId),
    purpose: 'prompt',
  }) === 'allow';
}

export function privateEventNoteExtractionContext(input: {
  repository: StoreRepository;
  session: SessionKey;
  targetSessionId: string;
  records: readonly MessageStorageRecord[];
  now: number;
}): PrivateEventNoteExtractionContext {
  if (input.session.kind !== 'private') throw new RangeError('事件注解提取只支持私聊');
  const ownerId = input.repository.mainUserIdFor(input.session.account, input.session.peer);
  const messageText = input.records
    .filter((record) => record.sessionId === input.targetSessionId
      && !record.isSelf && record.senderId === input.session.peer)
    .map((record) => record.plainText)
    .join('\n');
  const events = selectMemberVisibleGroupEvents({
    session: input.session,
    targetSessionId: input.targetSessionId,
    messageText,
    now: input.now,
    repository: input.repository,
  });
  const targetSessionId = input.targetSessionId;
  const existingNotes = input.repository.listGroupEventNotesForOwner(input.session.account, ownerId)
    .filter((note) => noteForPrivatePrompt(
      input.repository,
      note,
      input.session.account,
      ownerId,
      targetSessionId,
    ));
  return {
    ownerId,
    events,
    existingNotes,
    existingNoteSummaries: existingNotes.map(({ eventId, text, intent, level, status }) => ({
      eventId,
      text,
      intent,
      level,
      status,
    })),
  };
}

function evidenceIds(value: unknown, sourceMessages: ReadonlyMap<string, MessageStorageRecord>): string[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_EVENT_NOTE_EVIDENCE
    || value.some((id) => typeof id !== 'string' || !sourceMessages.has(id))) return undefined;
  return [...new Set(value as string[])];
}

function currentRevocationTime(records: readonly MessageStorageRecord[], sessionIdValue: string, ownerId: number): number | undefined {
  const times = records
    .filter((record) => record.sessionId === sessionIdValue && !record.isSelf
      && record.senderId === ownerId && explicitEventNoteRevocation(record.plainText))
    .map(({ time }) => time);
  return times.length > 0 ? Math.max(...times) : undefined;
}

export function applyPrivateEventNoteExtraction(input: {
  repository: StoreRepository;
  session: SessionKey;
  targetSessionId: string;
  ownerId: number;
  records: readonly MessageStorageRecord[];
  events: readonly PrivateGroupEventCandidate[];
  existingNotes: readonly StoredGroupEventNote[];
  notes: readonly unknown[];
  now: number;
}): number {
  if (input.session.kind !== 'private') return input.notes.length;
  const sourceMessages = new Map(input.records
    .filter((record) => record.sessionId === input.targetSessionId && !record.isSelf
      && record.senderId === input.session.peer)
    .map((record) => [record.messageId, record]));
  const allowedEventIds = new Set([
    ...input.events.map(({ id }) => id),
    ...input.existingNotes.map(({ eventId }) => eventId),
  ]);
  const initialNotes = new Map(input.existingNotes.map((note) => [note.eventId, note]));
  const currentNotes = input.repository.listGroupEventNotesForOwner(input.session.account, input.ownerId);
  const currentByEvent = new Map(currentNotes.map((note) => [note.eventId, note]));
  const latestRecords = input.repository.recentMessages(input.targetSessionId, 60);
  const revokeAt = currentRevocationTime(latestRecords, input.targetSessionId, input.session.peer);
  const handled = new Set<number>();
  let dropped = 0;
  const updates: GroupEventNoteInput[] = [];

  for (const candidate of input.notes) {
    const item = isRecord(candidate) ? candidate : undefined;
    const eventId = positiveId(item?.eventId) ? item.eventId : undefined;
    const intent = noteIntent(item?.intent) ? item.intent : undefined;
    const messageIds = evidenceIds(item?.messageIds, sourceMessages);
    const original = eventId === undefined ? undefined : initialNotes.get(eventId);
    if (eventId === undefined || !allowedEventIds.has(eventId) || !intent || !messageIds
      || handled.has(eventId)) {
      dropped += 1;
      continue;
    }
    handled.add(eventId);
    const existing = currentByEvent.get(eventId) ?? original;
    if (existing && existing.updatedAt > input.now) {
      dropped += 1;
      continue;
    }
    const latestEvidenceTime = messageIds.reduce((latest, id) => Math.max(latest, sourceMessages.get(id)?.time ?? 0), 0);
    const effectiveIntent = revokeAt !== undefined && revokeAt >= latestEvidenceTime ? 'confide' : intent;
    const text = item?.text === undefined ? existing?.text : boundedText(item.text);
    if (!text) {
      dropped += 1;
      continue;
    }
    const retainedIds = existing?.sourceSessionId === input.targetSessionId
      ? [...existing.sourceMessageIds, ...messageIds]
      : messageIds;
    const sourceMessageIds = [...new Set(retainedIds)].slice(-MAX_EVENT_NOTE_EVIDENCE);
    updates.push({
      account: input.session.account,
      eventId,
      ownerId: input.ownerId,
      sourceSessionId: input.targetSessionId,
      text: redactSensitiveText(text),
      intent: effectiveIntent,
      level: levelForIntent(effectiveIntent),
      status: effectiveIntent === 'confide' ? 'retracted' : 'active',
      sourceMessageIds,
      createdAt: existing?.createdAt ?? input.now,
      updatedAt: input.now,
    });
  }

  input.repository.transaction(() => {
    for (const note of updates) {
      const previous = currentByEvent.get(note.eventId);
      input.repository.upsertGroupEventNote(note);
      const requestedAt = note.sourceMessageIds.reduce(
        (latest, messageId) => Math.max(latest, sourceMessages.get(messageId)?.time ?? 0),
        0,
      );
      syncEventAdvocacyForNote({
        repository: input.repository,
        session: input.session,
        note,
        ...(previous ? { previous } : {}),
        requestedAt: requestedAt || input.now,
      });
    }
  });
  return dropped;
}

export function revokeEventNotesFromPrivateMessage(input: {
  repository: StoreRepository;
  session: SessionKey;
  messageId: string;
  senderId: number;
  now: number;
}): number {
  if (input.session.kind !== 'private' || input.senderId !== input.session.peer
    || !Number.isSafeInteger(input.now) || input.now < 0) return 0;
  const sourceSessionId = sessionId(input.session);
  const message = input.repository.messageBySessionAndId(sourceSessionId, input.messageId);
  if (!message || message.isSelf || message.senderId !== input.session.peer
    || !explicitEventNoteRevocation(message.plainText)) return 0;
  const ownerId = input.repository.mainUserIdFor(input.session.account, input.session.peer);
  const activeNotes = input.repository.listGroupEventNotesForOwner(input.session.account, ownerId)
    .filter((note) => note.status === 'active');
  const notes = revocationTargets({
    repository: input.repository,
    account: input.session.account,
    sourceSessionId,
    text: message.plainText,
    notes: activeNotes,
  });
  if (notes.length === 0) return 0;

  let retracted = 0;
  input.repository.transaction(() => {
    for (const note of notes) {
      const sourceMessageIds = note.sourceSessionId === sourceSessionId
        ? [...new Set([...note.sourceMessageIds, input.messageId])].slice(-MAX_EVENT_NOTE_EVIDENCE)
        : note.sourceMessageIds;
      const updated = input.repository.updateGroupEventNote(input.session.account, note.id, {
        sourceSessionId: note.sourceSessionId,
        text: note.text,
        intent: 'confide',
        level: 'L0',
        status: 'retracted',
        sourceMessageIds,
        updatedAt: Math.max(input.now, note.updatedAt) + 1,
      });
      if (updated) {
        if (note.intent === 'advocate') {
          input.repository.cancelEventAdvocacy(
            input.session.account,
            note.eventId,
            note.ownerId,
            updated.updatedAt,
          );
        }
        retracted += 1;
      }
    }
  });
  return retracted;
}

export function buildGroupEventContextBlock(input: {
  repository: StoreRepository;
  session: SessionKey;
  targetSessionId: string;
  now: number;
  template: ReplySystemTemplate;
  speakerNames: ReadonlyMap<number, string>;
}): string | undefined {
  if (input.session.kind !== 'group' || input.targetSessionId !== sessionId(input.session)
    || !Number.isSafeInteger(input.now) || input.now < 0) return undefined;
  const since = Math.max(0, input.now - GROUP_EVENT_LOOKBACK_MS);
  const events = input.repository.listGroupEvents(
    input.session.account,
    input.session.peer,
    since,
    MAX_GROUP_EVENTS_IN_PROMPT,
  ).filter((event) => event.occurredAt <= input.now);
  if (events.length === 0) return undefined;

  let noteCount = 0;
  const payload = JSON.stringify(events.map((event) => {
    const annotations: Array<{ intent: EventNoteIntent; text: string; speaker?: string }> = [];
    for (const note of input.repository.listGroupEventNotesForEvent(input.session.account, event.id, 'active')) {
      if (noteCount >= MAX_GROUP_EVENT_NOTES_IN_PROMPT) break;
      const ownerId = input.repository.mainUserIdFor(input.session.account, note.ownerId);
      const decision = decide({
        info: {
          origin: 'private',
          sessionId: note.sourceSessionId,
          ownerId,
          level: note.level,
          eventIntent: note.intent,
        },
        target: { kind: 'group', sessionId: input.targetSessionId },
        purpose: 'prompt',
      });
      if (decision !== 'allow') continue;
      const speaker = input.speakerNames.get(ownerId);
      const safeSpeaker = speaker ? redactSensitiveText(speaker) : undefined;
      annotations.push({
        intent: note.intent,
        text: redactSensitiveText(note.text),
        ...(safeSpeaker ? { speaker: safeSpeaker } : {}),
      });
      noteCount += 1;
      if (noteCount >= MAX_GROUP_EVENT_NOTES_IN_PROMPT) break;
    }
    return {
      time: new Date(event.occurredAt).toISOString(),
      title: redactSensitiveText(event.title),
      summary: redactSensitiveText(event.summary),
      ...(annotations.length > 0 ? { annotations } : {}),
    };
  }));
  return input.template.groupEvents.replace(/\{\{events\}\}/gu, () => payload);
}
