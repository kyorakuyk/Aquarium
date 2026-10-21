import { useEffect, useRef, useState } from 'react';
import { apiRequest, type TagCategory, type TagVetoView } from '../api.ts';

const CATEGORY_LABELS: Record<TagCategory, string> = {
  positioning: '定位',
  topic: '话题',
  atmosphere: '群氛围',
  meme: '群梗',
  norms: '规矩',
  identity: '自我认同',
  personality: '性格',
  fandom: '成分',
  speech: '说话风格',
  catchphrase: '口头禅',
  social: '社交方式',
  recent: '近况',
  dislike: '雷点',
  schedule: '作息',
  misc: '其他',
};

function formatTime(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(value);
}

export function TagVetoMenu({ sessionId, disabled, openRequest = 0, renderMenu = true }: {
  sessionId: string;
  disabled: boolean;
  openRequest?: number;
  renderMenu?: boolean;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [vetoes, setVetoes] = useState<TagVetoView[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<number>();
  const [error, setError] = useState('');
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (dialogOpen && !dialog.open) dialog.showModal();
    if (!dialogOpen && dialog.open) dialog.close();
  }, [dialogOpen]);

  useEffect(() => {
    if (openRequest > 0) setDialogOpen(true);
  }, [openRequest]);

  useEffect(() => {
    if (!dialogOpen) return undefined;
    let active = true;
    setLoading(true);
    setError('');
    void apiRequest<TagVetoView[]>(`/api/tag-vetoes?sessionId=${encodeURIComponent(sessionId)}`)
      .then((rows) => { if (active) setVetoes(rows); })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : '读取已否决标签失败');
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [dialogOpen, sessionId]);

  async function revoke(id: number): Promise<void> {
    if (busyId !== undefined) return;
    setBusyId(id);
    setError('');
    try {
      await apiRequest<void>(`/api/tag-vetoes/${id}`, { method: 'DELETE' });
      setVetoes((current) => current.filter((veto) => veto.id !== id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '撤销否决失败');
    } finally {
      setBusyId(undefined);
    }
  }

  return <>
    {renderMenu && <details className="impressions-data-menu">
      <summary className="button button-secondary">印象数据</summary>
      <div className="impressions-data-menu-items" role="menu">
        <button className="text-button" type="button" role="menuitem" disabled={disabled} onClick={() => setDialogOpen(true)}>
          已否决的标签…
        </button>
      </div>
    </details>}
    <dialog
      className="tag-vetoes-dialog"
      ref={dialogRef}
      aria-labelledby="tag-vetoes-title"
      onClose={() => setDialogOpen(false)}
      onCancel={() => setDialogOpen(false)}
    >
      <header className="tag-vetoes-heading">
        <div>
          <span className="eyebrow">印象数据</span>
          <h2 id="tag-vetoes-title">已否决的标签</h2>
        </div>
        <button className="button button-secondary" type="button" onClick={() => setDialogOpen(false)}>关闭</button>
      </header>
      {loading && <p className="muted" aria-live="polite">正在读取…</p>}
      {error && <p className="notice notice-warn" role="alert">{error}</p>}
      {!loading && vetoes.length === 0 && !error && <p className="muted">这个群还没有已否决的标签。</p>}
      {vetoes.length > 0 && <ul className="tag-vetoes-list">
        {vetoes.map((veto) => <li key={veto.id}>
          <div className="tag-vetoes-copy">
            <strong>{veto.textNorm || '（空标签）'}</strong>
            <span className="muted">{CATEGORY_LABELS[veto.category]} · {veto.userId === null ? '群标签' : `群友 ${veto.userId}`}</span>
            {veto.subjectNorm && <span className="muted">主题：{veto.subjectNorm.replaceAll('/', ' › ')}</span>}
            <time className="mono muted">{formatTime(veto.createdAt)}</time>
          </div>
          <button
            className="button button-secondary"
            type="button"
            disabled={busyId !== undefined}
            onClick={() => void revoke(veto.id)}
          >{busyId === veto.id ? '正在撤销…' : '撤销'}</button>
        </li>)}
      </ul>}
    </dialog>
  </>;
}
