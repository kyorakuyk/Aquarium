import type { ReplySystemTemplate } from '../prompt/templates.ts';
import { decide } from '../privacy/policy.ts';
import { createQqProfileService } from '../profiles/qq-profile-service.ts';
import { sessionId, type SessionKey } from '../shared/events.ts';
import type { StoreRepository } from '../../store/repository.ts';
import { redactSensitiveText } from './sensitive-text.ts';

const PRIVATE_EVENT_LOOKBACK_MS = 48 * 60 * 60_000;
const EVENT_SCAN_LIMIT = Number.MAX_SAFE_INTEGER;
const MAX_PRIVATE_GROUP_EVENTS = 3;

interface GroupEventCandidate {
  id: number;
  occurredAt: number;
  title: string;
  summary: string;
  keywordOverlap: number;
}

interface BuildPrivateGroupEventsBlockInput {
  session: SessionKey;
  targetSessionId: string;
  messageText: string;
  now: number;
  repository: StoreRepository;
  template: ReplySystemTemplate;
}

function keywords(value: string): Set<string> {
  const normalized = value.normalize('NFKC').toLocaleLowerCase();
  const result = new Set<string>();
  for (const match of normalized.matchAll(/[a-z0-9]{2,}/giu)) result.add(match[0]);
  for (const match of normalized.matchAll(/\p{Script=Han}+/gu)) {
    const characters = Array.from(match[0]);
    for (let index = 0; index + 1 < characters.length; index += 1) {
      result.add(characters.slice(index, index + 2).join(''));
    }
  }
  return result;
}

function keywordOverlap(messageKeywords: Set<string>, eventText: string): number {
  let count = 0;
  for (const keyword of keywords(eventText)) {
    if (messageKeywords.has(keyword)) count += 1;
  }
  return count;
}

function compareRelevance(first: GroupEventCandidate, second: GroupEventCandidate): number {
  return second.keywordOverlap - first.keywordOverlap
    || second.occurredAt - first.occurredAt
    || second.id - first.id;
}

function compareRecency(first: GroupEventCandidate, second: GroupEventCandidate): number {
  return second.occurredAt - first.occurredAt || second.id - first.id;
}

export function buildPrivateGroupEventsBlock(
  input: BuildPrivateGroupEventsBlockInput,
): string | undefined {
  const { session } = input;
  if (session.kind !== 'private' || !Number.isSafeInteger(input.now) || input.now < 0
    || input.targetSessionId !== sessionId(session)) return undefined;

  const since = Math.max(0, input.now - PRIVATE_EVENT_LOOKBACK_MS);
  const profileService = createQqProfileService({
    repository: input.repository,
    now: () => input.now,
  });
  const messageKeywords = keywords(input.messageText);
  const candidates: GroupEventCandidate[] = [];

  for (const groupId of input.repository.listRecentGroupEventGroupIds(session.account, since)) {
    const isFreshMember = profileService.getCachedMemberProfile(session.account, groupId, session.peer) !== undefined;
    const memberIds = isFreshMember ? [session.peer] : [];
    const sourceSessionId = sessionId({ account: session.account, kind: 'group', peer: groupId });
    const events = input.repository.listGroupEvents(session.account, groupId, since, EVENT_SCAN_LIMIT);

    for (const event of events) {
      if (event.occurredAt < since || event.occurredAt > input.now) continue;
      const eventMemberIds = event.sourceGroupId === groupId ? memberIds : [];
      const decision = decide({
        info: {
          origin: 'group',
          sessionId: sourceSessionId,
          ownerId: null,
          eventGroupMemberIds: eventMemberIds,
        },
        target: { kind: 'private', sessionId: input.targetSessionId, peerId: session.peer },
        purpose: 'prompt',
      });
      if (decision !== 'allow') continue;

      const title = redactSensitiveText(event.title);
      const summary = redactSensitiveText(event.summary);
      candidates.push({
        id: event.id,
        occurredAt: event.occurredAt,
        title,
        summary,
        keywordOverlap: keywordOverlap(messageKeywords, `${title} ${summary}`),
      });
    }
  }

  const selected = candidates.sort(compareRelevance).slice(0, MAX_PRIVATE_GROUP_EVENTS).sort(compareRecency);
  if (selected.length === 0) return undefined;

  const payload = JSON.stringify(selected.map((event) => ({
    time: new Date(event.occurredAt).toISOString(),
    title: event.title,
    summary: event.summary,
  })));
  return input.template.groupEvents.replace(/\{\{events\}\}/gu, () => payload);
}
