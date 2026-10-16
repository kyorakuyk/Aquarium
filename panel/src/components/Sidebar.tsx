import { FishIcon } from './FishIcon.tsx';

export type PageId = 'overview' | 'sessions' | 'personas' | 'sandbox' | 'usage' | 'impressions';

const pages: Array<{ id: PageId; label: string }> = [
  { id: 'overview', label: '总览' },
  { id: 'sessions', label: '会话' },
  { id: 'personas', label: '人设' },
  { id: 'sandbox', label: '试聊与决策' },
  { id: 'usage', label: '用量' },
  { id: 'impressions', label: '印象' },
];

export function Sidebar({
  page,
  onSelect,
  onLogout,
}: {
  page: PageId;
  onSelect: (page: PageId) => void;
  onLogout: () => void;
}) {
  return (
    <aside className="sidebar">
      <div className="brand-lockup">
        <FishIcon className="brand-fish" />
        <div>
          <div className="brand-title">水族箱</div>
          <div className="brand-subtitle">AQUARIUM</div>
        </div>
      </div>
      <nav className="main-nav" aria-label="主导航">
        {pages.map((item) => (
          <button
            className={`nav-item ${page === item.id ? 'is-active' : ''}`}
            key={item.id}
            type="button"
            onClick={() => onSelect(item.id)}
            aria-current={page === item.id ? 'page' : undefined}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className="coming-soon">
        <div className="section-eyebrow">即将开放</div>
        {['群友', '存档'].map((label) => (
          <button className="nav-item nav-disabled" key={label} type="button" disabled>
            <span>{label}</span><span className="m2-tag">M2</span>
          </button>
        ))}
      </div>
      <button className="logout-button" type="button" onClick={onLogout}>退出登录</button>
    </aside>
  );
}
