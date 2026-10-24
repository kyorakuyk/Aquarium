import type { PanelStatus } from '../api.ts';

export interface PersonaCard {
  id: string;
  filename: string;
  source: 'data' | 'built-in';
}

export function PersonaLibraryToolbar({
  personas,
  accounts,
  selectedId,
  loading,
  busy,
  onSelect,
  onImport,
  onNew,
}: {
  personas: PersonaCard[];
  accounts: PanelStatus['accounts'];
  selectedId: string;
  loading: boolean;
  busy: boolean;
  onSelect: (id: string) => void;
  onImport: () => void;
  onNew: () => void;
}) {
  return (
    <header className="page-header page-header-actions persona-library-header">
      <h1>人设</h1>
      <div className="persona-library-row" role="group" aria-label="人设库">
        {personas.map((persona) => {
          const bound = accounts.filter((account) => account.persona === persona.id);
          return (
            <button
              className={`persona-library-chip ${selectedId === persona.id ? 'is-selected' : ''}`}
              type="button"
              aria-pressed={selectedId === persona.id}
              title={`${persona.filename} · ${persona.source === 'built-in' ? '内置人设副本' : '人设文件'}`}
              key={persona.id}
              disabled={busy}
              onClick={() => onSelect(persona.id)}
            >
              <strong>{persona.id}</strong>
              {bound.length > 0 && <small>在用 · {bound.length}</small>}
            </button>
          );
        })}
        {!loading && personas.length === 0 && <p className="muted">还没有人设，先创建一个。</p>}
        {loading && <p className="muted">正在读取人设库…</p>}
      </div>
      <div className="persona-library-actions">
        <button className="button button-secondary" type="button" disabled={busy} onClick={onImport}>导入 Markdown</button>
        <button className="button button-primary" type="button" disabled={busy} onClick={onNew}>新建人设</button>
      </div>
    </header>
  );
}
