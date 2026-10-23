import type { StoreRepository } from '../../store/repository.ts';
import type { MessageStorageRecord } from '../../store/repository-types.ts';
import { redactSensitiveText } from './sensitive-text.ts';
import { asEventItem, isExternalLinkShareText } from './extract.ts';
import { sessionId, type SessionKey } from '../shared/events.ts';

export function persistExtractedGroupEvents(input: {
  repository: Pick<StoreRepository, 'upsertGroupEvent'>;
  session: SessionKey;
  records: readonly MessageStorageRecord[];
  events: readonly unknown[];
  now: number;
}): void {
  if (input.session.kind !== 'group') return;
  const targetSessionId = sessionId(input.session);
  const recordsById = new Map(input.records
    .filter((record) => record.sessionId === targetSessionId)
    .map((record) => [record.messageId, record]));
  const participantIds = new Set(input.records
    .filter((record) => record.sessionId === targetSessionId && !record.isSelf && record.senderId !== input.session.account)
    .map((record) => record.senderId));

  for (const raw of input.events) {
    const event = asEventItem(raw);
    if (!event || event.participantIds.some((userId) => !participantIds.has(userId))) continue;
    const evidence = event.messageIds.map((messageId) => recordsById.get(messageId));
    if (evidence.some((record) => !record || record.isSelf || isExternalLinkShareText(record.plainText))) continue;
    const orderedEvidence = evidence
      .filter((record): record is MessageStorageRecord => record !== undefined)
      .sort((first, second) => first.time - second.time || first.messageId.localeCompare(second.messageId));
    const firstEvidence = orderedEvidence[0];
    if (!firstEvidence) continue;

    const title = redactSensitiveText(event.title);
    const summary = redactSensitiveText(event.summary);
    if (Array.from(title).length < 1 || Array.from(title).length > 16
      || Array.from(summary).length < 1 || Array.from(summary).length > 60) continue;
    const orderedMessageIds = orderedEvidence.map((record) => record.messageId);
    input.repository.upsertGroupEvent({
      account: input.session.account,
      sourceGroupId: input.session.peer,
      anchorMessageId: firstEvidence.messageId,
      title,
      summary,
      participantIds: event.participantIds,
      evidenceMessageIds: orderedMessageIds,
      occurredAt: firstEvidence.time,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }
}
