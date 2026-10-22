import { useEffect, useState } from 'react';
import { apiRequest, type PersonaTraits, type PersonaVersionDocument, type PersonaVersionSummary } from '../api.ts';
import { PERSONA_TRAIT_LABELS } from '../persona-sections.ts';
import { redactSensitiveText } from '../../../src/core/impressions/sensitive-text.ts';
import { PersonaEvolutionCharts, PERSONA_TRAIT_COLORS, type PersonaEvolutionView } from './PersonaEvolutionCharts.tsx';
import { PersonaVersionDiffDialog } from './PersonaVersionDiffDialog.tsx';

const neutralTraits: PersonaTraits = {
  order: 0, morality: 0, talk: 0, mind: 0, humor: 0, openness: 0, imitation: 0,
};
const viewLabels: Array<{ key: PersonaEvolutionView | 'source'; label: string }> = [
  { key: 'increment', label: '增量' },
  { key: 'trajectory', label: '轨迹' },
  { key: 'radar', label: '雷达' },
  { key: 'source', label: '来源' },
];
function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function formatDelta(value: number): string {
  return value > 0 ? `+${value}` : value < 0 ? `−${Math.abs(value)}` : '0';
}

export function PersonaEvolution({
  personaId,
  refreshKey,
  onRestore,
}: {
  personaId: string;
  refreshKey: number;
  onRestore: (markdown: string) => void;
}) {
  const [versions, setVersions] = useState<PersonaVersionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [view, setView] = useState<PersonaEvolutionView | 'source'>('increment');
  const [selectedVersionId, setSelectedVersionId] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionMessage, setActionMessage] = useState('');
  const [diff, setDiff] = useState<{ previousMarkdown: string | null; currentMarkdown: string } | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let active = true;
    setVersions([]);
    setSelectedVersionId(null);
    setShowAll(false);
    setActionMessage('');
    setLoading(true);
    setError('');
    void apiRequest<PersonaVersionSummary[]>(`/api/personas/${encodeURIComponent(personaId)}/versions`).then((items) => {
      if (!active) return;
      setVersions(items);
      setSelectedVersionId((current) => items.some((item) => item.id === current)
        ? current
        : items[1]?.id ?? items[0]?.id ?? null);
      setLoading(false);
    }).catch((reason: unknown) => {
      if (!active) return;
      setError(reason instanceof Error ? reason.message : '读取人设版本失败');
      setLoading(false);
    });
    return () => { active = false; };
  }, [personaId, refreshKey, retryKey]);

  const currentTraits = versions[0]?.traits ?? neutralTraits;
  const selectedVersion = versions.find((item) => item.id === selectedVersionId);
  const visibleVersions = showAll ? versions : versions.slice(0, 4);

  async function loadDiff(version: PersonaVersionSummary, index: number) {
    setActionBusy(true);
    setActionMessage('');
    try {
      const current = await apiRequest<PersonaVersionDocument>(
        `/api/personas/${encodeURIComponent(personaId)}/versions/${version.id}`,
      );
      const previousId = versions[index + 1]?.id;
      const previous = previousId === undefined ? null : await apiRequest<PersonaVersionDocument>(
        `/api/personas/${encodeURIComponent(personaId)}/versions/${previousId}`,
      );
      setDiff({ previousMarkdown: previous?.markdown ?? null, currentMarkdown: current.markdown });
    } catch (reason) {
      setActionMessage(reason instanceof Error ? reason.message : '读取版本差异失败');
    } finally {
      setActionBusy(false);
    }
  }

  async function restoreVersion(version: PersonaVersionSummary) {
    setActionBusy(true);
    setActionMessage('');
    try {
      const restored = await apiRequest<{ id: number; markdown: string; traits: PersonaTraits }>(
        `/api/personas/${encodeURIComponent(personaId)}/versions/${version.id}/restore`,
        { method: 'POST' },
      );
      onRestore(restored.markdown);
      setActionMessage('版本已载入编辑器，尚未保存。');
    } catch (reason) {
      setActionMessage(reason instanceof Error ? reason.message : '载入版本失败');
    } finally {
      setActionBusy(false);
    }
  }

  return (
    <section className="persona-evolution-card panel-card" aria-labelledby="persona-evolution-title">
      <header className="persona-evolution-heading">
        <div><h2 id="persona-evolution-title">性格的变化</h2><p className="muted">此阶段没有经历偏移；现在等于底色。</p></div>
      </header>

      <div className="persona-evolution-stats" aria-label="七维性格底色与现在">
        {PERSONA_TRAIT_LABELS.map((dimension) => (
          <div className="persona-evolution-stat" key={dimension.key}>
            <strong>{dimension.title}{'locked' in dimension && dimension.locked ? ' · 锁定' : ''}</strong>
            <span className="mono">{currentTraits[dimension.key]} → {currentTraits[dimension.key]}</span>
          </div>
        ))}
      </div>

      <div className="persona-evolution-views" role="group" aria-label="性格变化视图">
        {viewLabels.map((item) => {
          const viewKey = item.key;
          return (
            <button
              key={viewKey}
              className={view === viewKey ? 'is-active' : ''}
              type="button"
              disabled={viewKey === 'source'}
              aria-pressed={view === viewKey}
              title={viewKey === 'source' ? '性格演进上线后可用' : undefined}
              onClick={() => { if (viewKey !== 'source') setView(viewKey); }}
            >{item.label}</button>
          );
        })}
      </div>
      <p className="persona-evolution-mode-note">来源视图：性格演进上线后可用。</p>

      {view === 'radar' && (
        <label className="persona-radar-version-picker">
          <span>所选历史版本</span>
          <select
            aria-label="雷达图历史版本"
            value={selectedVersionId ?? ''}
            onChange={(event) => setSelectedVersionId(Number(event.currentTarget.value))}
            disabled={versions.length === 0}
          >
            {versions.map((item) => <option key={item.id} value={item.id}>{formatDate(item.savedAt)} · #{item.id}</option>)}
          </select>
        </label>
      )}

      <div className="persona-evolution-plot">
        {loading ? <p className="muted">正在读取版本…</p> : error ? (
          <div><p className="notice notice-warn" role="alert">{error}</p><button className="button button-secondary" type="button" onClick={() => setRetryKey((value) => value + 1)}>重试</button></div>
        ) : view === 'source' ? (
          <p className="muted">性格演进上线后可用</p>
        ) : (
          <PersonaEvolutionCharts
            view={view}
            versions={versions}
            currentTraits={currentTraits}
            selectedVersion={selectedVersion}
          />
        )}
      </div>

      <div className="persona-evolution-legend" aria-label="性格维度颜色图例">
        {PERSONA_TRAIT_LABELS.map((dimension) => (
          <span key={dimension.key}><i style={{ backgroundColor: PERSONA_TRAIT_COLORS[dimension.key] }} />{dimension.title}</span>
        ))}
      </div>
      <p className="persona-evolution-note">模仿（锁定）不随经历变化；可在表单中手动设置。</p>

      <div className="persona-version-history">
        <div className="persona-version-history-heading"><h3>文字记录</h3>{versions.length > 4 && (
          <button className="text-button" type="button" disabled={loading} onClick={() => setShowAll((current) => !current)}>
            {showAll ? '收起' : `查看全部 ${versions.length} 条`}
          </button>
        )}</div>
        {actionMessage && <p className="muted persona-version-message" role="status">{redactSensitiveText(actionMessage)}</p>}
        {!loading && !error && visibleVersions.length === 0 && <p className="muted">还没有保存版本。</p>}
        {visibleVersions.map((version) => {
          const actualIndex = versions.findIndex((item) => item.id === version.id);
          return (
            <article className="persona-version-entry" key={version.id}>
              <div className="persona-version-entry-content">
                <time className="mono" dateTime={new Date(version.savedAt).toISOString()}>{formatDate(version.savedAt)} · #{version.id}</time>
                <p>{redactSensitiveText(version.summary)}</p>
                <div className="persona-version-deltas">
                  {PERSONA_TRAIT_LABELS.filter((field) => version.traitsDelta[field.key] !== 0).map((field) => (
                    <span key={field.key}>{field.title} {formatDelta(version.traitsDelta[field.key])}</span>
                  ))}
                </div>
              </div>
              <div className="persona-version-actions">
                <button className="text-button" type="button" disabled={loading || actionBusy} onClick={() => void loadDiff(version, actualIndex)}>查看差异</button>
                <button className="text-button" type="button" disabled={loading || actionBusy} onClick={() => void restoreVersion(version)}>恢复</button>
              </div>
            </article>
          );
        })}
      </div>
      <div className="persona-evolution-back-action">
        <button className="text-button" type="button" disabled title="性格演进上线后可用">回到底色</button>
        <span className="muted">性格演进上线后可用</span>
      </div>
      <PersonaVersionDiffDialog
        open={diff !== null}
        previousMarkdown={diff?.previousMarkdown ?? null}
        currentMarkdown={diff?.currentMarkdown ?? ''}
        onClose={() => setDiff(null)}
      />
    </section>
  );
}
