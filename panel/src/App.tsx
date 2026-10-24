import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { apiRequest, clearAuthentication, UNAUTHORIZED_EVENT } from './api.ts';
import { Sidebar, type PageId } from './components/Sidebar.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { parseAppHash, serializeAppHash } from './hash-navigation.ts';

const LoginPage = lazy(() => import('./pages/LoginPage.tsx').then((module) => ({ default: module.LoginPage })));
const OverviewPage = lazy(() => import('./pages/OverviewPage.tsx').then((module) => ({ default: module.OverviewPage })));
const SessionsPage = lazy(() => import('./pages/SessionsPage.tsx').then((module) => ({ default: module.SessionsPage })));
const PersonasPage = lazy(() => import('./pages/PersonasPage.tsx').then((module) => ({ default: module.PersonasPage })));
const DecisionsPage = lazy(() => import('./pages/DecisionsPage.tsx').then((module) => ({ default: module.DecisionsPage })));
const UsagePage = lazy(() => import('./pages/UsagePage.tsx').then((module) => ({ default: module.UsagePage })));
const ImpressionsPage = lazy(() => import('./pages/ImpressionsPage.tsx').then((module) => ({ default: module.ImpressionsPage })));
const PersonalImpressionsPage = lazy(() => import('./pages/PersonalImpressionsPage.tsx').then((module) => ({ default: module.PersonalImpressionsPage })));
const ModelsPage = lazy(() => import('./pages/ModelsPage.tsx').then((module) => ({ default: module.ModelsPage })));
const StickersPage = lazy(() => import('./pages/StickersPage.tsx').then((module) => ({ default: module.StickersPage })));
const EventBookPage = lazy(() => import('./pages/EventBookPage.tsx').then((module) => ({ default: module.EventBookPage })));

function PageLoading() {
  return <p className="muted" role="status">正在加载页面…</p>;
}

export function App() {
  const [authenticated, setAuthenticated] = useState(
    () => Boolean(sessionStorage.getItem('aquarium-panel-password')),
  );
  const [page, setPage] = useState<PageId>(() => parseAppHash(window.location.hash)?.page ?? 'overview');
  const [focusSleepSettings, setFocusSleepSettings] = useState(false);

  useEffect(() => {
    const syncPage = () => {
      const route = parseAppHash(window.location.hash);
      if (!route) window.history.replaceState(window.history.state, '', serializeAppHash({ page: 'overview' }));
      setPage(route?.page ?? 'overview');
    };
    if (!parseAppHash(window.location.hash)) {
      window.history.replaceState(window.history.state, '', serializeAppHash({ page: 'overview' }));
    }
    window.addEventListener('hashchange', syncPage);
    window.addEventListener('popstate', syncPage);
    return () => {
      window.removeEventListener('hashchange', syncPage);
      window.removeEventListener('popstate', syncPage);
    };
  }, []);

  useEffect(() => {
    const expire = () => setAuthenticated(false);
    window.addEventListener(UNAUTHORIZED_EVENT, expire);
    if (authenticated) void apiRequest('/api/status').catch(() => {
      clearAuthentication();
      setAuthenticated(false);
    });
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, expire);
  }, [authenticated]);

  function logout() {
    clearAuthentication();
    setAuthenticated(false);
  }

  function navigateTo(nextPage: PageId): void {
    if (nextPage === page) return;
    const nextHash = serializeAppHash({ page: nextPage });
    if (window.location.hash !== nextHash) window.history.pushState(window.history.state, '', nextHash);
    setPage(nextPage);
  }

  function openSleepSettings(): void {
    navigateTo('sessions');
    setFocusSleepSettings(true);
  }

  const finishSleepSettingsRequest = useCallback(() => setFocusSleepSettings(false), []);

  if (!authenticated) {
    return <ErrorBoundary key="login">
      <Suspense fallback={<PageLoading />}>
        <LoginPage onAuthenticated={() => setAuthenticated(true)} />
      </Suspense>
    </ErrorBoundary>;
  }

  return (
    <div className="app-shell">
      <Sidebar page={page} onSelect={navigateTo} onLogout={logout} />
      <main className="main-content">
        <ErrorBoundary key={page}>
          <Suspense fallback={<PageLoading />}>
            {page === 'overview' && <OverviewPage onNavigate={navigateTo} onOpenSleepSettings={openSleepSettings} />}
            {page === 'sessions' && <SessionsPage
              focusSleepSettings={focusSleepSettings}
              onSleepSettingsOpened={finishSleepSettingsRequest}
            />}
            {page === 'personas' && <PersonasPage onNavigate={navigateTo} />}
            {page === 'models' && <ModelsPage />}
            {page === 'sandbox' && <DecisionsPage />}
            {page === 'usage' && <UsagePage />}
            {page === 'impressions' && <ImpressionsPage />}
            {page === 'events' && <EventBookPage />}
            {page === 'personal-impressions' && <PersonalImpressionsPage />}
            {page === 'stickers' && <StickersPage />}
          </Suspense>
        </ErrorBoundary>
      </main>
    </div>
  );
}
