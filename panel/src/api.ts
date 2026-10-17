export const PASSWORD_KEY = 'aquarium-panel-password';
export const UNAUTHORIZED_EVENT = 'aquarium-panel-unauthorized';

export interface PanelAccount {
  account: number;
  name: string;
  persona: string;
  snowlumaConfigured: boolean;
  connectionStatus: 'connecting' | 'online' | 'offline';
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

export interface TagEvidenceView {
  messageId: string;
  time: number;
  quote: string;
}

export interface TagView {
  id: number;
  text: string;
  status: TagStatus;
  source: 'auto' | 'manual';
  samples: number;
  activation: number;
  evidence: TagEvidenceView[];
  firstSeen: number;
  lastSeen: number;
}

export interface ImpressionsView {
  sessionId: string;
  groupTags: TagView[];
  members: Array<{ userId: number; name: string; affinity: AffinityView; tags: TagView[] }>;
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
      if (typeof body.error === 'string') message = body.error;
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
