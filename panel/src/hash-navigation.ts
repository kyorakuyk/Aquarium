import type { PageId } from './components/Sidebar.tsx';

const PAGE_IDS: readonly PageId[] = ['overview', 'sessions', 'impressions', 'personas', 'personal-impressions', 'stickers', 'models', 'usage', 'sandbox'];

export interface AppHashState {
  page: PageId;
  sessionId?: string;
  userId?: number;
}

export function parseAppHash(hash: string): AppHashState | undefined {
  if (!hash.startsWith('#/')) return undefined;
  const [rawPage, query = ''] = hash.slice(2).split('?', 2);
  if (!PAGE_IDS.includes(rawPage as PageId)) return undefined;
  const page = rawPage as PageId;
  if (page !== 'impressions') return { page };

  const params = new URLSearchParams(query);
  const sessionId = params.get('sessionId') ?? undefined;
  if (!sessionId) return { page };

  const state: AppHashState = { page, sessionId };
  const userId = Number(params.get('userId'));
  if (Number.isSafeInteger(userId) && userId > 0) state.userId = userId;
  return state;
}

export function serializeAppHash(state: AppHashState): string {
  const base = `#/${state.page}`;
  if (state.page !== 'impressions') return base;
  const params = new URLSearchParams();
  if (state.sessionId) params.set('sessionId', state.sessionId);
  if (state.sessionId && Number.isSafeInteger(state.userId) && (state.userId ?? 0) > 0) {
    params.set('userId', String(state.userId));
  }
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}
