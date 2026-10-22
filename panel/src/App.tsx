import { useEffect, useState } from 'react';
import { apiRequest, clearAuthentication, UNAUTHORIZED_EVENT } from './api.ts';
import { Sidebar, type PageId } from './components/Sidebar.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { OverviewPage } from './pages/OverviewPage.tsx';
import { SessionsPage } from './pages/SessionsPage.tsx';
import { PersonasPage } from './pages/PersonasPage.tsx';
import { DecisionsPage } from './pages/DecisionsPage.tsx';
import { UsagePage } from './pages/UsagePage.tsx';
import { ImpressionsPage } from './pages/ImpressionsPage.tsx';
import { PersonalImpressionsPage } from './pages/PersonalImpressionsPage.tsx';
import { ModelsPage } from './pages/ModelsPage.tsx';
import { StickersPage } from './pages/StickersPage.tsx';
import { parseAppHash, serializeAppHash } from './hash-navigation.ts';

export function App() {
  const [authenticated, setAuthenticated] = useState(
    () => Boolean(sessionStorage.getItem('aquarium-panel-password')),
  );
  const [page, setPage] = useState<PageId>(() => parseAppHash(window.location.hash)?.page ?? 'overview');

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

  if (!authenticated) {
    return <LoginPage onAuthenticated={() => setAuthenticated(true)} />;
  }

  return (
    <div className="app-shell">
      <Sidebar page={page} onSelect={navigateTo} onLogout={logout} />
      <main className="main-content">
        {page === 'overview' && <OverviewPage onNavigate={navigateTo} />}
        {page === 'sessions' && <SessionsPage />}
        {page === 'personas' && <PersonasPage onNavigate={navigateTo} />}
        {page === 'models' && <ModelsPage />}
        {page === 'sandbox' && <DecisionsPage />}
        {page === 'usage' && <UsagePage />}
        {page === 'impressions' && <ImpressionsPage />}
        {page === 'personal-impressions' && <PersonalImpressionsPage />}
        {page === 'stickers' && <StickersPage />}
      </main>
    </div>
  );
}
