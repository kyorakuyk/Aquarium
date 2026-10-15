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

export interface SessionView {
  sessionId: string;
  name: string;
  kind: 'group' | 'private';
  degraded: boolean;
  memberCount?: number;
  enabled: boolean;
  overrides: string[];
  effective: {
    mode: 'mention_only' | 'active' | 'natural' | 'busy';
    nicknames: string[];
    contextMessages: number;
    rate: {
      perUserPerMinute: number;
      perSessionPerMinute: number;
      minIntervalSec: number;
    };
    groupNote: string;
  };
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

export function post(path: string, body?: unknown): Promise<unknown> {
  return apiRequest(path, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

export function patch<T>(path: string, body: unknown): Promise<T> {
  return apiRequest<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
}
