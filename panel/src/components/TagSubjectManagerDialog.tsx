import { useEffect, useRef, useState } from 'react';
import { apiRequest, type TagSubjectView } from '../api.ts';
import { containsSensitiveText, redactSensitiveText } from '../../../src/core/impressions/sensitive-text.ts';

function aliasList(value: string): string[] {
  return value.split(/[,，\n]/u).map((alias) => alias.trim()).filter(Boolean);
}

export function TagSubjectManagerDialog({ open, sessionId, onClose }: {
  open: boolean;
  sessionId: string;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [subjects, setSubjects] = useState<TagSubjectView[]>([]);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [newName, setNewName] = useState('');
  const [newAliases, setNewAliases] = useState('');
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<number | 'new'>();
  const [error, setError] = useState('');

  const endpoint = `/api/tag-subjects/${encodeURIComponent(sessionId)}/fandom`;

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const result = await apiRequest<TagSubjectView[]>(endpoint);
      setSubjects(result);
      setDrafts(Object.fromEntries(result.map((subject) => [subject.id, subject.aliases.join(', ')])));
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '读取成分别名失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    if (open) void load();
  }, [open, endpoint]);

  async function save(name: string, aliasesText: string, id: number | 'new'): Promise<void> {
    const aliases = aliasList(aliasesText);
    if (containsSensitiveText(name) || containsSensitiveText(aliases.join(' '))) {
      if (id === 'new') {
        setNewName('');
        setNewAliases('');
      } else {
        setDrafts((current) => ({ ...current, [id]: '' }));
      }
      setError('疑似敏感凭据已清除，未发送。');
      return;
    }
    setBusyId(id);
    setError('');
    try {
      await apiRequest<TagSubjectView>(endpoint, {
        method: 'PUT',
        body: JSON.stringify({ name, aliases }),
      });
      if (id === 'new') {
        setNewName('');
        setNewAliases('');
      }
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存成分别名失败');
    } finally {
      setBusyId(undefined);
    }
  }

  return <dialog
    className="tag-subject-dialog"
    ref={dialogRef}
    aria-labelledby="tag-subject-title"
    onClose={onClose}
    onCancel={(event) => { event.preventDefault(); onClose(); }}
  >
    <div className="tag-subject-heading">
      <div><h2 id="tag-subject-title">成分别名管理</h2><p className="muted">别名会归一到同一个标准名称，避免同一成分出现多种写法。</p></div>
      <button className="button button-secondary" type="button" aria-label="关闭别名管理" onClick={onClose}>关闭</button>
    </div>
    {error && <p className="notice notice-warn" role="alert">{error}</p>}
    {loading && <p className="muted" role="status">正在读取别名…</p>}
    {!loading && subjects.length === 0 && <p className="muted">还没有标准成分；可在下方新增。</p>}
    <div className="tag-subject-list">
      {subjects.map((subject) => <form
        className="tag-subject-row"
        key={subject.id}
        onSubmit={(event) => { event.preventDefault(); void save(subject.name, drafts[subject.id] ?? '', subject.id); }}
      >
        <strong>{redactSensitiveText(subject.name)}</strong>
        <label>
          <span className="field-label">别名（逗号分隔）</span>
          <input
            value={drafts[subject.id] ?? ''}
            aria-label={`${subject.name}的别名`}
            disabled={busyId !== undefined}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setDrafts((current) => ({ ...current, [subject.id]: value }));
            }}
          />
        </label>
        <div className="tag-subject-aliases">{subject.aliases.map((alias) => <span className="status-pill" key={alias}>{redactSensitiveText(alias)}</span>)}</div>
        <button className="button button-secondary" type="submit" disabled={busyId !== undefined}>保存别名</button>
      </form>)}
    </div>
    <form className="tag-subject-new" onSubmit={(event) => {
      event.preventDefault();
      if (newName.trim()) void save(newName.trim(), newAliases, 'new');
    }}>
      <h3>新增标准成分</h3>
      <label><span className="field-label">标准名称</span><input value={newName} maxLength={40} onChange={(event) => setNewName(event.currentTarget.value)} /></label>
      <label><span className="field-label">别名（逗号分隔）</span><input value={newAliases} onChange={(event) => setNewAliases(event.currentTarget.value)} /></label>
      <button className="button button-primary" type="submit" disabled={busyId !== undefined || !newName.trim()}>新增</button>
    </form>
  </dialog>;
}
