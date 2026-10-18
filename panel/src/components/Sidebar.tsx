import { useEffect, useState } from 'react';
import { apiRequest, post, type PanelStatus, type SleepView } from '../api.ts';
import { sidebarEnergyLabel } from '../sidebar-energy.ts';
import { FishIcon } from './FishIcon.tsx';

export type PageId = 'overview' | 'sessions' | 'impressions' | 'personas' | 'models' | 'usage' | 'sandbox';

const navGroups: Array<{ label: string; items: Array<{ id: PageId; label: string }> }> = [
  { label: '日常', items: [{ id: 'overview', label: '总览' }, { id: 'sessions', label: '会话' }, { id: 'impressions', label: '印象' }] },
  { label: '塑造', items: [{ id: 'personas', label: '人设' }] },
  { label: '系统', items: [{ id: 'models', label: '模型' }, { id: 'usage', label: '用量' }, { id: 'sandbox', label: '试聊与决策' }] },
];

function NavIcon({ page }: { page: PageId }) {
  const props = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true as const };
  switch (page) {
    case 'overview': return <svg {...props}><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></svg>;
    case 'sessions': return <svg {...props}><path d="M4 5h11a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H9l-4 3v-3H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" /></svg>;
    case 'impressions': return <svg {...props}><path d="M20 12l-8 8-9-9V3h8z" /><circle cx="7.5" cy="7.5" r="1.5" /></svg>;
    case 'personas': return <svg {...props}><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="11" r="2.5" /><path d="M15 10h3M15 14h3" /></svg>;
    case 'models': return <svg {...props}><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3" /></svg>;
    case 'usage': return <svg {...props}><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></svg>;
    case 'sandbox': return <svg {...props}><path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3" /></svg>;
  }
}

function connectionLabel(status: PanelStatus['accounts'][number]['connectionStatus'] | undefined): string {
  if (status === 'online') return '在线';
  if (status === 'connecting') return '连接中';
  return '等待重连';
}

export function Sidebar({
  page,
  onSelect,
  onLogout,
}: {
  page: PageId;
  onSelect: (page: PageId) => void;
  onLogout: () => void;
}) {
  const [status, setStatus] = useState<PanelStatus>();
  const [sleep, setSleep] = useState<SleepView>();
  const [muting, setMuting] = useState(false);
  const [muteError, setMuteError] = useState('');

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      const [statusResult, sleepResult] = await Promise.allSettled([
        apiRequest<PanelStatus>('/api/status'),
        apiRequest<SleepView>('/api/sleep'),
      ]);
      if (!active) return;
      if (statusResult.status === 'fulfilled') setStatus(statusResult.value);
      if (sleepResult.status === 'fulfilled') setSleep(sleepResult.value);
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const accounts = status?.accounts ?? [];
  const account = accounts[0];
  const presence = connectionLabel(account?.connectionStatus);
  const energy = sidebarEnergyLabel(sleep?.enabled ?? false, sleep?.energy ?? null);

  async function toggleMute() {
    if (!status || muting) return;
    setMuting(true);
    setMuteError('');
    try {
      await post(status.allMuted ? '/api/unmute-all' : '/api/mute-all');
      setStatus(await apiRequest<PanelStatus>('/api/status'));
    } catch {
      setMuteError('切换闭嘴状态失败，请重试。');
    } finally {
      setMuting(false);
    }
  }

  return (
    <aside className="sidebar">
      <div className="brand-lockup">
        <FishIcon className="brand-fish" />
        <div>
          <div className="brand-title">水族箱</div>
          <div className="brand-subtitle">AQUARIUM</div>
        </div>
      </div>
      <button className="account-switcher" type="button" disabled={accounts.length <= 1} aria-label={`切换眷属；${account?.name ?? '尚无眷属'}，${presence}${sleep?.enabled ? ` · ${energy}` : ''}`}>
        <span className="account-avatar" aria-hidden="true">{Array.from(account?.name ?? '眷')[0] ?? '眷'}<span className={`connection-dot ${account?.connectionStatus === 'online' ? 'is-online' : account?.connectionStatus === 'connecting' ? 'is-connecting' : ''}`} /></span>
        <span className="account-copy"><span className="account-name">{account?.name ?? '尚无眷属'}</span><span className="account-presence">{sleep?.enabled ? `${presence} · ${energy}` : presence}</span></span>
        <svg className="account-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M7 10l5-5 5 5M7 14l5 5 5-5" /></svg>
      </button>
      <nav className="main-nav" aria-label="主导航">
        {navGroups.map((group) => <div className="nav-group" key={group.label}>
          <span className="nav-group-label">{group.label}</span>
          {group.items.map((item) => <button
            className={`nav-item ${page === item.id ? 'is-active' : ''}`}
            key={item.id}
            type="button"
            onClick={() => onSelect(item.id)}
            aria-current={page === item.id ? 'page' : undefined}
          ><NavIcon page={item.id} /><span>{item.label}</span></button>)}
        </div>)}
      </nav>
      <div className="sidebar-footer">
        <svg className="sidebar-waves" viewBox="0 0 184 56" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
          <path d="M0 14c15 0 15-8 30-8s15 8 30 8 15-8 31-8 15 8 30 8 15-8 31-8 16 8 32 8" />
          <path d="M0 30c15 0 15-8 30-8s15 8 30 8 15-8 31-8 15 8 30 8 15-8 31-8 16 8 32 8" />
          <path d="M0 46c15 0 15-8 30-8s15 8 30 8 15-8 31-8 15 8 30 8 15-8 31-8 16 8 32 8" />
        </svg>
        <button className={`sidebar-muted-button ${status?.allMuted ? 'is-muted' : ''}`} type="button" disabled={!status || muting} onClick={() => void toggleMute()}>
          {status?.allMuted ? '恢复发言' : '全部闭嘴'}
        </button>
        {muteError && <p className="sidebar-muted-error" role="alert">{muteError}</p>}
        <button className="logout-button" type="button" onClick={onLogout}>退出登录</button>
      </div>
    </aside>
  );
}
