import { redactSensitiveText } from '../../src/core/impressions/sensitive-text.ts';

export const PASSWORD_KEY = 'aquarium-panel-password';
export const UNAUTHORIZED_EVENT = 'aquarium-panel-unauthorized';

export interface PanelAccount {
  account: number;
  name: string;
  persona: string;
  snowlumaConfigured: boolean;
  connectionStatus: 'connecting' | 'online' | 'offline' | 'waiting_login';
  connectionHint: string | null;
  degraded: boolean;
  todayReplyCount: number;
  lastReplyAt: number | null;
  lastReplyText: string | null;
}

export interface PanelStatus {
  accounts: PanelAccount[];
  todayReplyCount: number;
  todayCostCny: number;
  budgetState: { state: 'ok' | 'warn' | 'exceeded'; dailyLimitCny: number; todayCostCny: number };
  enabledSessionCount: number;
  allMuted: boolean;
  ownerConfigured: boolean;
  runtime: { pid: number; port: number; uptimeSeconds: number };
}

export type SessionMode = 'mention_only' | 'active' | 'natural' | 'busy';

export interface ModeScheduleEntry {
  from: string;
  to: string;
  mode: SessionMode;
}

export interface SessionSettings {
  mode: SessionMode;
  modeSchedule: ModeScheduleEntry[];
  proactiveCooldownSec: number;
  talkOffset: number;
  nicknames: string[];
  contextMessages: number;
  rate: {
    perUserPerMinute: number;
    perSessionPerMinute: number;
    minIntervalSec: number;
  };
  groupNote: string;
}

export interface PersonaTraits {
  order: number;
  morality: number;
  talk: number;
  mind: number;
  humor: number;
  openness: number;
  imitation: number;
}

export interface PersonaVersionSummary {
  id: number;
  savedAt: number;
  traits: PersonaTraits;
  traitsDelta: PersonaTraits;
  summary: string;
}

export interface PersonaVersionDocument {
  id: number;
  savedAt: number;
  markdown: string;
  traits: PersonaTraits;
  note: string | null;
}

export interface DefaultsView extends SessionSettings {
  enabled: boolean;
}

export interface SessionView {
  sessionId: string;
  name: string;
  kind: 'group' | 'private';
  degraded: boolean;
  memberCount?: number;
  enabled: boolean;
  lastMessageAt: number | null;
  overrides: string[];
  effective: SessionSettings;
}

export interface DecisionView {
  id: number;
  time: number;
  sessionId: string;
  sessionName: string;
  messageId: string;
  messageText: string | null;
  costCny: number | null;
  replied: boolean;
  reason: string;
  detail: unknown;
  hasDebugTrace: boolean;
  hasPipelineTrace: boolean;
}

export type MoodBand = 'low' | 'annoyed' | 'calm' | 'happy' | 'excited';

export interface MoodEventView {
  id: number;
  time: number;
  source: 'appraise' | 'rule' | 'band';
  sessionId: string | null;
  senderId: number | null;
  dv: number;
  da: number;
  appliedDv: number;
  appliedDa: number;
  reason: string;
  bandBefore: MoodBand | null;
  bandAfter: MoodBand | null;
  valenceAfter: number | null;
  arousalAfter: number | null;
}

export interface MoodView {
  valence: number;
  arousal: number;
  band: MoodBand;
  bandSince: number | null;
  events: MoodEventView[];
}

export type SleepStatus = 'awake' | 'asleep' | 'woken';

export interface SleepView {
  enabled: boolean;
  bedtime: string;
  wake: string;
  wakeWords: string[];
  goodnight: boolean;
  status: SleepStatus;
  energy: number | null;
  nextChangeAt: number | null;
  cycleKey: string;
  account: number | null;
}

export type TagStatus = 'candidate' | 'confirmed' | 'rejected' | 'superseded';
export type TagKind = 'fact' | 'view';
export type TagCategory = 'positioning' | 'topic' | 'atmosphere' | 'meme' | 'norms' | 'identity' | 'personality' | 'fandom' | 'speech' | 'catchphrase' | 'social' | 'recent' | 'dislike' | 'schedule' | 'misc';
export type TagOrigin = 'self_report' | 'inferred' | 'stats' | 'manual';
export type TagPolarity = 'like' | 'dislike' | null;

export type TagEvidenceView = {
  kind?: 'message';
  messageId: string;
  time: number;
  quote: string;
} | {
  kind: 'signature';
  text: string;
  fetchedAt: number;
};

export interface TagView {
  id: number;
  text: string;
  category: TagCategory;
  kind: TagKind;
  subject: string | null;
  polarity: TagPolarity;
  origin: TagOrigin;
  locked: boolean;
  fadeAt: number | null;
  status: TagStatus;
  source: 'auto' | 'manual';
  samples: number;
  activation: number;
  evidence: TagEvidenceView[];
  firstSeen: number;
  lastSeen: number;
}

export interface TagVetoView {
  id: number;
  userId: number | null;
  category: TagCategory;
  subjectNorm: string;
  textNorm: string;
  createdAt: number;
}

export interface QqGroupProfileView {
  groupInfo: {
    groupName?: string;
    memberCount?: number;
    maxMemberCount?: number;
    groupCreateTime?: number;
    groupLevel?: number;
    groupDescription?: string;
  } | null;
  honors: Array<{ kind: 'dragon_king' | 'performer' | 'legend' | 'emotion' | 'strong_newbie'; userId?: number; nickname?: string }> | null;
  latestNotice: string | null;
  essenceCount: number | null;
  membersAvailable: boolean;
  composition: {
    sex: { male: number; female: number; unknown: number };
    joinDuration: { overThreeYears: number; oneToThreeYears: number; withinOneYear: number; unknown: number };
  } | null;
  fetchedAt: number | null;
}

export interface QqMemberProfileView {
  card?: string;
  role?: 'owner' | 'admin' | 'member';
  title?: string;
  joinTime?: number;
  lastSentTime?: number;
  level?: string;
  sex?: 'male' | 'female' | 'unknown';
  age?: number;
  qage?: number;
  isRobot?: boolean;
}

export type AccountKind = 'human' | 'bot' | 'alt' | 'owner';
export type RelationType = 'alt' | 'lover' | 'brother' | 'sister' | 'roommate' | 'enemy' | 'other';

export interface MemberRelationView {
  id: number;
  type: RelationType;
  label: string | null;
  locked: boolean;
  otherUserId: number;
  otherName: string;
  currentRole: 'main' | 'alt' | null;
}

export interface QqMemberTargetView {
  userId: number;
  name: string;
  card?: string;
}

export interface ImpressionsView {
  sessionId: string;
  lastMessageTime: number | null;
  groupTags: TagView[];
  groupTagsText: string | null;
  groupScheduleDrop: { text: string; time: number } | null;
  qqGroupProfile: QqGroupProfileView | null;
  qqMembers: QqMemberTargetView[];
  members: Array<{
    userId: number;
    name: string;
    messageCount: number;
    lastMessageTime: number | null;
    scheduleDrop: { text: string; time: number } | null;
    kind: AccountKind | null;
    relations: MemberRelationView[];
    affinity: AffinityView;
    qqProfile: QqMemberProfileView | null;
    tags: TagView[];
    memberTagsAllowed: boolean;
    memberTagsText: string | null;
  }>;
}

export interface GroupSummaryView {
  account: number;
  sessionId: string;
  text: string;
  manual: boolean;
  updatedAt: number;
}

export interface MemberSummaryView {
  account: number;
  userId: number;
  text: string;
  manual: boolean;
  updatedAt: number;
}

export interface TagSubjectView {
  id: number;
  account: number;
  category: TagCategory;
  name: string;
  aliases: string[];
}

export type ActivityView = 'hour' | 'week' | 'month' | 'year';

export interface ActivitySummaryView {
  total: number;
  avgChars: number;
  imageRatio: number;
}

export interface ActivitySuggestionView {
  from: string;
  to: string;
  windowKey: string;
  ratio: number;
}

export interface ActivityDistributionView {
  view: 'hour' | 'week';
  buckets: number[];
  summary: ActivitySummaryView;
  suggestion?: ActivitySuggestionView | null;
}

export interface ActivityCalendarView {
  view: 'month' | 'year';
  buckets: Array<{ date: string; count: number }>;
  summary: ActivitySummaryView;
}

export type ActivityResponseView = ActivityDistributionView | ActivityCalendarView;

export type PrivacyFactLevel = 'L0' | 'L1' | 'L2';

export interface PrivacyFactEvidenceView {
  messageId: string;
  time: number;
  quote: string;
}

export interface PrivacyFactView {
  id: number;
  text: string;
  textRedacted: boolean;
  keywords: string[];
  level: PrivacyFactLevel;
  levelSource: 'auto' | 'manual';
  mentions: number;
  evidence: PrivacyFactEvidenceView[];
}

export interface PrivacyFactsView {
  userId: number;
  name: string;
  facts: PrivacyFactView[];
}

export type HistoryImportMode = 'incremental' | 'full';
export type HistoryImportPhase = 'fetching' | 'awaiting_confirmation' | 'extracting' | 'done' | 'cancelled' | 'expired' | 'error';

export interface HistoryImportJobView {
  id: string;
  sessionId: string;
  mode: HistoryImportMode;
  phase: HistoryImportPhase;
  fetched: number;
  inserted: number;
  newMessages: number;
  waterlineTime: number | null;
  estimatedCostCny?: number;
  confirmationExpiresAt?: number;
  previewChanged?: boolean;
  windowsDone: number;
  windowsTotal: number;
  windowsFailed: number;
  failureReason?: 'timeout' | 'network' | 'http' | 'other';
  failureHttpStatus?: number;
  tagsInserted: number;
  tagsObserved: number;
  costCny: number;
  error?: string;
  cancelRequested?: boolean;
}

export type AffinityLevel = 'cold' | 'cool' | 'neutral' | 'warm' | 'close';

export interface AffinityView {
  userId: number;
  name: string;
  value: number;
  level: AffinityLevel;
  lastInteractionAt: number | null;
}

export interface AffinityEventView {
  id: number;
  account: number;
  userId: number;
  time: number;
  source: 'appraise' | 'called' | 'manual' | 'band';
  sessionId: string | null;
  delta: number;
  applied: number;
  reason: string;
  levelBefore: AffinityLevel | null;
  levelAfter: AffinityLevel | null;
}

export interface AffinityDetailView extends AffinityView {
  events: AffinityEventView[];
}

export interface TraceView {
  id: number;
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

export interface PipelineStepTraceView {
  step: string;
  startedAt: number;
  durationMs: number;
  summary: string;
  detail?: unknown;
}

export interface DecisionReplayView {
  decisionId: number;
  original: {
    replied: boolean;
    reason: string;
    replyCostCny: number | null;
    trace: PipelineStepTraceView[];
  };
  replay: {
    wouldReply: boolean;
    reason: string;
    replyText: string;
    trace: PipelineStepTraceView[];
    provider?: string;
    model?: string;
    replyCostCny?: number;
    totalCostCny?: number;
    parts?: string[];
  };
}

export interface UsageView {
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

export interface UsageSlotView {
  slot: string;
  calls: number;
  costCny: number;
  avgLatencyMs: number;
}

export interface UsageRowView {
  provider: string;
  account: number | null;
  calls: number;
  costCny: number;
  avgLatencyMs: number;
  cacheHitRatio: number | null;
  daily: number[];
  bySlot: UsageSlotView[];
}

export interface UsageRangeView {
  totals: {
    costCny: number;
    calls: number;
    cacheHitRatio: number | null;
    budgetToday: { used: number; limit: number };
  };
  rows: UsageRowView[];
}

export type ModelReasoning = 'off' | 'low' | 'medium' | 'high';
export type CliRuntimeState = 'stopped' | 'starting' | 'ready' | 'busy' | 'restarting';

export interface KeyStatusView {
  set: boolean;
  last4: string;
}

export interface CliRuntimeView {
  state: CliRuntimeState;
  pid: number | null;
  served: number;
}

export interface ModelProviderView {
  id: string;
  kind: 'api' | 'cli';
  label: string;
  keyStatus: KeyStatusView;
  baseUrl?: string;
  reasoningField?: string;
  apiKeyEnv?: string;
  modelParams?: Record<string, { temperature?: boolean; maxTokens?: boolean; reasoning?: boolean }>;
  command?: string;
  args?: string[];
  prewarm?: boolean;
  timeoutSec?: number;
  runtime?: CliRuntimeView;
}

export interface ModelSlotEntryView {
  provider: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  timeoutSec?: number;
  reasoning: ModelReasoning;
}

export interface ModelsView {
  providers: ModelProviderView[];
  slots: Record<string, ModelSlotEntryView[]>;
  pricing: Record<string, { input: number; cachedInput: number; output: number }>;
}

export interface DecisionStep {
  step: string;
  status: string;
  [key: string]: unknown;
}

export async function authenticate(password: string): Promise<boolean> {
  try {
    const response = await fetch('/api/status', {
      headers: { Authorization: `Bearer ${password}` },
    });
    if (!response.ok) return false;
    sessionStorage.setItem(PASSWORD_KEY, password);
    return true;
  } catch {
    return false;
  }
}

export function clearAuthentication(): void {
  sessionStorage.removeItem(PASSWORD_KEY);
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const password = sessionStorage.getItem(PASSWORD_KEY);
  if (password) headers.set('Authorization', `Bearer ${password}`);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, { ...init, headers });
  if (response.status === 401) {
    clearAuthentication();
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new Error('登录已失效');
  }
  if (!response.ok) {
    let message = `请求失败（${response.status}）`;
    try {
      const body = await response.json() as { error?: unknown };
      if (typeof body.error === 'string') message = redactSensitiveText(body.error);
    } catch {
      // Keep the generic status message for non-JSON errors.
    }
    throw new Error(message);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function replayDecision(id: number): Promise<DecisionReplayView> {
  return apiRequest<DecisionReplayView>(`/api/decisions/${id}/replay`, { method: 'POST' });
}

export function post(path: string, body?: unknown): Promise<unknown> {
  return apiRequest(path, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

export function patch<T>(path: string, body: unknown): Promise<T> {
  return apiRequest<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
}
