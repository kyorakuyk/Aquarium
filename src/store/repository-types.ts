import type {
  AffinityEventRecord,
  AffinityStateRecord,
  MoodEventRecord,
  MoodStateRecord,
  StoredAffinityEvent,
  StoredMoodEvent,
  StoredTag,
  TagKind,
  TagRecord,
  TagRunRecord,
  TagUpdate,
} from './affect-repo.ts';
import type {
  PrivateFactControlsRepository,
  PrivateFactMentionRepository,
  PrivacyRepository,
} from './privacy-repo.ts';
import type { PersonaVersionRepository } from './persona-version-repo.ts';
import type { RecentExtractUsageRepository } from './recent-extract-usage-repo.ts';
import type { QqProfileRepository } from './qq-profile-repo.ts';
import type { StickerRepository } from './sticker-repo.ts';
import type { TagVetoRepository } from './tag-veto-repo.ts';
import type { IdentityRepository } from './identity-repo.ts';
import type { GroupSummaryRepository } from './group-summary-repo.ts';
import type { TagDropRepository } from './tag-drop-repo.ts';
import type { KinGroupRepository } from './kin-group-repo.ts';
import type { PersonaMemoryRepository } from './persona-memory-repo.ts';
import type { EventRepository } from './event-repo.ts';
import type {
  PersonaAffinityEventRecord,
  PersonaAffinityStateRecord,
  StoredPersonaAffinityEvent,
} from './persona-affinity-repo.ts';

export interface MessageStorageRecord {
  sessionId: string;
  messageId: string;
  senderId: number;
  senderName: string;
  isSelf: boolean;
  plainText: string;
  segments: unknown[];
  time: number;
}

export interface MemberMessageStats {
  userId: number;
  messageCount: number;
  lastMessageTime: number;
}

export interface UsageRecord {
  time: number;
  account: number | null;
  slot: string;
  provider: string;
  model: string;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  costCny: number;
  latencyMs: number;
  ok: boolean;
}

export interface UsageSummary {
  requestCount: number;
  successfulRequests: number;
  failedRequests: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  costCny: number;
  averageLatencyMs: number;
}

export type UsageRange = 'today' | '7d' | '30d';

export type ImageCaptionKind = 'sticker' | 'photo' | 'screenshot' | 'other';

export interface ImageCaptionRecord {
  md5: string;
  caption: string;
  kind: ImageCaptionKind;
  desc: string;
  text: string;
  legible: boolean;
  visionModel: string;
  visionTemplateVersion: string;
  time: number;
}

export interface UsageSlotSummary {
  slot: string;
  calls: number;
  costCny: number;
  avgLatencyMs: number;
}

export interface UsageAccountSummary {
  provider: string;
  account: number | null;
  calls: number;
  costCny: number;
  avgLatencyMs: number;
  cacheHitRatio: number | null;
  daily: number[];
  bySlot: UsageSlotSummary[];
}

export interface UsageRangeSummary {
  totals: {
    costCny: number;
    calls: number;
    cacheHitRatio: number | null;
  };
  rows: UsageAccountSummary[];
}

export interface DecisionRecord {
  time: number;
  sessionId: string;
  messageId: string;
  replied: boolean;
  reason: string;
  detail: unknown;
}

export interface StoredDecision extends DecisionRecord {
  id: number;
}

export interface DebugTraceRecord {
  time: number;
  sessionId: string;
  messageId: string;
  slot: string;
  provider: string;
  model: string;
  promptJson: string;
  responseText: string;
  promptHash: string;
  detail: unknown;
}

export interface StoredDebugTrace extends DebugTraceRecord {
  id: number;
}

export interface PipelineTraceRecord {
  time: number;
  sessionId: string;
  messageId: string;
  trace: unknown[];
}

export interface StoredPipelineTrace extends PipelineTraceRecord {
  id: number;
}

export interface StoreRepository extends RecentExtractUsageRepository, PersonaVersionRepository, PrivacyRepository, PrivateFactMentionRepository, PrivateFactControlsRepository, StickerRepository, TagVetoRepository, QqProfileRepository, IdentityRepository, GroupSummaryRepository, TagDropRepository, KinGroupRepository, PersonaMemoryRepository, EventRepository {
  transaction<T>(task: () => T): T;
  resetImpressionsSession(account: number, sessionId: string): { tags: number; vetoes: number };
  saveMessage(message: MessageStorageRecord): boolean;
  updateMessageSegments(sessionId: string, messageId: string, segments: unknown[]): void;
  recentMessages(sessionId: string, count: number): MessageStorageRecord[];
  messagesInRange(sessionId: string, fromTime: number, toTime: number): MessageStorageRecord[];
  memberMessageStats(sessionId: string): MemberMessageStats[];
  profileActivitySessions(fromTime: number, toTime: number): string[];
  lastMessageTime(sessionId: string): number | null;
  lastMessageBefore(sessionId: string, beforeTime: number): MessageStorageRecord | undefined;
  messageBySessionAndId(sessionId: string, messageId: string): MessageStorageRecord | undefined;
  recentMessagesThrough(sessionId: string, messageId: string, count: number): MessageStorageRecord[];
  lastSelfMessage(sessionId: string): MessageStorageRecord | undefined;
  latestSelfMessageForAccount(account: number): MessageStorageRecord | undefined;
  selfMessagesById(messageId: string): MessageStorageRecord[];
  recordUsage(usage: UsageRecord): void;
  costToday(): number;
  replyCountToday(): number;
  replyCountTodayForAccount(account: number): number;
  replyCountLastHourForAccount(account: number, now: number): number;
  replyTimesForAccount(account: number, fromTime: number, toTime: number): number[];
  usageToday(): UsageSummary;
  usageByRange(range: UsageRange, now: number): UsageRangeSummary;
  getCaption(key: string): string | undefined;
  setCaption(key: string, caption: string, time?: number): void;
  getImageCaption(md5: string): ImageCaptionRecord | undefined;
  setImageCaption(record: ImageCaptionRecord): void;
  recordDecision(decision: DecisionRecord): void;
  recentDecisions(count: number): StoredDecision[];
  decisionsInRange(sessionId: string, fromTime: number, toTime: number): StoredDecision[];
  latestReplyDecision(): StoredDecision | undefined;
  decisionMessageText(sessionId: string, messageId: string): string | undefined;
  decisionById(id: number): StoredDecision | undefined;
  hasDebugTrace(sessionId: string, messageId: string): boolean;
  recordDebugTrace(trace: DebugTraceRecord): void;
  debugTracesFor(sessionId: string, messageId: string): StoredDebugTrace[];
  pruneDebugTraces(now: number, retainDays?: number): number;
  hasPipelineTrace(sessionId: string, messageId: string): boolean;
  recordPipelineTrace(trace: PipelineTraceRecord): void;
  pipelineTraceFor(sessionId: string, messageId: string): StoredPipelineTrace | undefined;
  prunePipelineTraces(now: number, retainDays?: number): number;
  getMoodState(account: number): MoodStateRecord | undefined;
  saveMoodState(state: MoodStateRecord): void;
  recordMoodEvent(event: MoodEventRecord): void;
  recentMoodEvents(account: number, count: number): StoredMoodEvent[];
  moodEventsSince(account: number, since: number): StoredMoodEvent[];
  latestMoodEventAtOrBefore(account: number, time: number): StoredMoodEvent | undefined;
  getAffinityState(account: number, userId: number): AffinityStateRecord | undefined;
  listAffinityStates(account: number): AffinityStateRecord[];
  saveAffinityState(state: AffinityStateRecord): void;
  recordAffinityEvent(event: AffinityEventRecord): void;
  recentAffinityEvents(account: number, userId: number, count: number): StoredAffinityEvent[];
  affinityEventsSince(account: number, userId: number, since: number): StoredAffinityEvent[];
  getPersonaAffinityState(account: number, userId: number, personaId: string): PersonaAffinityStateRecord | undefined;
  listPersonaAffinityStates(account: number, personaId: string): PersonaAffinityStateRecord[];
  savePersonaAffinityState(state: PersonaAffinityStateRecord): void;
  recordPersonaAffinityEvent(event: PersonaAffinityEventRecord): void;
  recentPersonaAffinityEvents(account: number, userId: number, personaId: string, count: number): StoredPersonaAffinityEvent[];
  personaAffinityEventsSince(account: number, userId: number, personaId: string, since: number): StoredPersonaAffinityEvent[];
  latestSenderNameForAccount(account: number, userId: number): string | undefined;
  insertTag(tag: TagRecord): number;
  tagById(id: number): StoredTag | undefined;
  deleteTag(id: number, expected?: { account: number; kind: TagKind }): boolean;
  listTagsForSubject(account: number, sessionId: string, userId: number | null): StoredTag[];
  listTagsForSession(account: number, sessionId: string): StoredTag[];
  listGroupTagsForUser(account: number, userId: number): StoredTag[];
  listViewTagsForAccount(account: number): StoredTag[];
  listFactTagsForAccounts(accounts: readonly number[]): StoredTag[];
  listRelayTagsForAccount(account: number): StoredTag[];
  senderNameFor(sessionId: string, senderId: number): string | undefined;
  updateTag(id: number, update: TagUpdate): void;
  deleteActivityTag(id: number): void;
  getTagRun(account: number, sessionId: string): TagRunRecord | undefined;
  saveTagRun(run: TagRunRecord): void;
  countMessagesAfter(sessionId: string, time: number): number;
}
