import { useEffect, useState } from 'react';
import { apiRequest, type PanelStatus } from '../api.ts';
import type { PersonaCounterpartsView } from '../persona-counterpart-api.ts';
import { PERSONA_COUNTERPARTS_UPDATED_EVENT } from '../persona-counterpart-events.ts';

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
  const [expanded, setExpanded] = useState(false);
  const [pendingCounts, setPendingCounts] = useState<Record<string, number>>({});
  const [counterpartRefresh, setCounterpartRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    void Promise.all(personas.map(async (persona) => {
      try {
        const result = await apiRequest<PersonaCounterpartsView>(
          `/api/personas/${encodeURIComponent(persona.id)}/counterparts`,
        );
        return [persona.id, result.claims.length] as const;
      } catch {
        return [persona.id, 0] as const;
      }
    })).then((entries) => {
      if (active) setPendingCounts(Object.fromEntries(entries));
    });
    const refresh = () => setCounterpartRefresh((current) => current + 1);
    window.addEventListener(PERSONA_COUNTERPARTS_UPDATED_EVENT, refresh);
    return () => {
      active = false;
      window.removeEventListener(PERSONA_COUNTERPARTS_UPDATED_EVENT, refresh);
    };
  }, [counterpartRefresh, personas]);
  const selectedIndex = personas.findIndex((persona) => persona.id === selectedId);
  const collapsedLimit = 3;
  const visible = expanded || personas.length <= collapsedLimit + 1
    ? personas
    : personas.filter((persona, index) => index < collapsedLimit || index === selectedIndex);
  const hiddenCount = personas.length - visible.length;
  return (
    <header className="page-header page-header-actions persona-library-header">
      <h1>人设</h1>
      <div className="persona-library-row" role="group" aria-label="人设库">
        {visible.map((persona) => {
          const bound = accounts.filter((account) => account.persona === persona.id);
          const pendingCount = pendingCounts[persona.id] ?? 0;
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
              {bound.length > 0 && <small aria-label={`${bound.length} 个眷属在用`}>· 在用</small>}
              {pendingCount > 0 && <span className="persona-counterpart-count" aria-label={`${pendingCount} 条待认领`}>{pendingCount}</span>}
            </button>
          );
        })}
        {(hiddenCount > 0 || (expanded && personas.length > collapsedLimit + 1)) && (
          <button
            className="persona-library-chip persona-library-more"
            type="button"
            aria-expanded={expanded}
            title={expanded ? '收起人设库' : '展开全部人设'}
            onClick={() => setExpanded((current) => !current)}
          >{expanded ? '收起' : `+${hiddenCount}`}</button>
        )}
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
