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
import { ModelsPage } from './pages/ModelsPage.tsx';
import { StickersPage } from './pages/StickersPage.tsx';

export function App() {
  const [authenticated, setAuthenticated] = useState(
    () => Boolean(sessionStorage.getItem('aquarium-panel-password')),
  );
  const [page, setPage] = useState<PageId>('overview');

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

  if (!authenticated) {
    return <LoginPage onAuthenticated={() => setAuthenticated(true)} />;
  }

  return (
    <div className="app-shell">
      <Sidebar page={page} onSelect={setPage} onLogout={logout} />
      <main className="main-content">
        {page === 'overview' && <OverviewPage onNavigate={setPage} />}
        {page === 'sessions' && <SessionsPage />}
        {page === 'personas' && <PersonasPage onNavigate={setPage} />}
        {page === 'models' && <ModelsPage />}
        {page === 'sandbox' && <DecisionsPage />}
        {page === 'usage' && <UsagePage />}
        {page === 'impressions' && <ImpressionsPage />}
        {page === 'stickers' && <StickersPage />}
      </main>
    </div>
  );
}
