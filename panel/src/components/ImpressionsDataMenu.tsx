import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { apiRequest, post } from '../api.ts';
import { TagVetoMenu } from './TagVetoMenu.tsx';

interface ImportPreview {
  added: number;
  conflicts: number;
  vetoes: number;
  summaries: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function groupFileName(groupName: string): string {
  return groupName.trim().replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '-').replace(/\s+/gu, '-').slice(0, 80) || 'group';
}

function localDateStamp(): string {
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date()).replaceAll('-', '');
}

export function ImpressionsDataMenu({ sessionId, groupName, groupTagCount, memberTagCount, disabled, onChanged }: {
  sessionId: string;
  groupName: string;
  groupTagCount: number;
  memberTagCount: number;
  disabled: boolean;
  onChanged: () => Promise<boolean>;
}) {
  const menuRef = useRef<HTMLDetailsElement>(null);
  const exportDialogRef = useRef<HTMLDialogElement>(null);
  const importDialogRef = useRef<HTMLDialogElement>(null);
  const resetDialogRef = useRef<HTMLDialogElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [labelsIncluded, setLabelsIncluded] = useState(true);
  const [subjectsIncluded, setSubjectsIncluded] = useState(true);
  const [vetoesIncluded, setVetoesIncluded] = useState(true);
  const [activityIncluded, setActivityIncluded] = useState(false);
  const [l1Included, setL1Included] = useState(false);
  const [importDocument, setImportDocument] = useState<Record<string, unknown>>();
  const [fileName, setFileName] = useState('');
  const [preview, setPreview] = useState<ImportPreview>();
  const [mode, setMode] = useState<'merge' | 'overwrite'>('merge');
  const [confirmation, setConfirmation] = useState('');
  const [resetCounts, setResetCounts] = useState<{ groupTags: number; memberTags: number; vetoes: number }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [vetoOpenRequest, setVetoOpenRequest] = useState(0);

  useEffect(() => {
    const dialog = exportDialogRef.current;
    if (!dialog) return;
    if (exportOpen && !dialog.open) dialog.showModal();
    if (!exportOpen && dialog.open) dialog.close();
  }, [exportOpen]);

  useEffect(() => {
    const dialog = importDialogRef.current;
    if (!dialog) return;
    if (importOpen && !dialog.open) dialog.showModal();
    if (!importOpen && dialog.open) dialog.close();
  }, [importOpen]);

  useEffect(() => {
    const dialog = resetDialogRef.current;
    if (!dialog) return;
    if (resetOpen && !dialog.open) dialog.showModal();
    if (!resetOpen && dialog.open) dialog.close();
  }, [resetOpen]);

  function closeMenu(): void {
    menuRef.current?.removeAttribute('open');
  }

  function openExport(): void {
    closeMenu();
    setError('');
    setExportOpen(true);
  }

  function openImport(): void {
    closeMenu();
    setError('');
    setStatus('');
    setImportDocument(undefined);
    setFileName('');
    setPreview(undefined);
    setImportOpen(true);
  }

  async function chooseImportFile(file: File): Promise<void> {
    setBusy(true);
    setError('');
    setStatus('');
    setFileName(file.name);
    try {
      const parsed: unknown = JSON.parse(await file.text());
      if (!isRecord(parsed)) throw new Error('文件内容必须是 JSON 对象');
      if (typeof parsed.sessionId === 'string' && parsed.sessionId !== sessionId) {
        const sourceGroup = typeof parsed.groupName === 'string' ? parsed.groupName : '文件中的群';
        throw new Error(`文件属于「${sourceGroup}」，与当前选择的群不一致。`);
      }
      const result = await apiRequest<ImportPreview>('/api/impressions/import/preview', {
        method: 'POST',
        body: JSON.stringify(parsed),
      });
      setImportDocument(parsed);
      setPreview(result);
    } catch (reason) {
      setImportDocument(undefined);
      setPreview(undefined);
      setError(reason instanceof Error ? reason.message : '读取导入文件失败');
    } finally {
      setBusy(false);
    }
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>): void {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = '';
    if (file) void chooseImportFile(file);
  }

  async function exportData(): Promise<void> {
    if (!sessionId || busy) return;
    setBusy(true);
    setError('');
    try {
      const include = [
        ...(labelsIncluded ? ['tags', 'summaries'] : []),
        ...(subjectsIncluded ? ['subjects'] : []),
        ...(vetoesIncluded ? ['vetoes'] : []),
        'relations',
        ...(activityIncluded ? ['activity'] : []),
        ...(l1Included ? ['l1'] : []),
      ].join(',');
      const exported = await apiRequest<unknown>(
        `/api/impressions/export?sessionId=${encodeURIComponent(sessionId)}&include=${encodeURIComponent(include)}`,
      );
      const blob = new Blob([`${JSON.stringify(exported, null, 2)}\n`], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `aquarium-impressions-${groupFileName(groupName)}-${localDateStamp()}.json`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setExportOpen(false);
      setStatus('印象数据已导出。');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '导出印象数据失败');
    } finally {
      setBusy(false);
    }
  }

  async function importData(): Promise<void> {
    if (!importDocument || !preview || busy) return;
    setBusy(true);
    setError('');
    try {
      await post('/api/impressions/import', { ...importDocument, mode });
      await onChanged();
      setImportOpen(false);
      setStatus('印象数据已导入。');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '导入印象数据失败');
    } finally {
      setBusy(false);
    }
  }

  async function loadResetCounts(): Promise<void> {
    setBusy(true);
    setError('');
    setResetCounts(undefined);
    try {
      const vetoes = await apiRequest<unknown[]>(
        `/api/tag-vetoes?sessionId=${encodeURIComponent(sessionId)}`,
      );
      setResetCounts({
        groupTags: groupTagCount,
        memberTags: memberTagCount,
        vetoes: vetoes.length,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '读取初始化范围失败');
    } finally {
      setBusy(false);
    }
  }

  function openReset(): void {
    closeMenu();
    setError('');
    setStatus('');
    setConfirmation('');
    setResetCounts(undefined);
    setResetOpen(true);
    void loadResetCounts();
  }

  async function resetData(): Promise<void> {
    if (confirmation !== groupName || !resetCounts || busy) return;
    setBusy(true);
    setError('');
    try {
      await post('/api/impressions/reset', { sessionId, confirm: confirmation });
      await onChanged();
      setResetOpen(false);
      setStatus('已备份并初始化当前群的印象数据。');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '初始化印象数据失败');
    } finally {
      setBusy(false);
    }
  }

  return <>
    <details className="impressions-data-menu" ref={menuRef}>
      <summary className="button button-secondary">印象数据</summary>
      <div className="impressions-data-menu-items" role="menu">
        <button className="text-button" type="button" role="menuitem" disabled={disabled || busy || !sessionId} onClick={openExport}>导出这个群…</button>
        <button className="text-button" type="button" role="menuitem" disabled={disabled || busy || !sessionId} onClick={openImport}>导入…</button>
        <button className="text-button" type="button" role="menuitem" disabled={disabled || busy || !sessionId} onClick={() => { closeMenu(); setVetoOpenRequest((value) => value + 1); }}>已否决的标签…</button>
        <button className="text-button impressions-data-reset-item" type="button" role="menuitem" disabled={disabled || busy || !sessionId} onClick={openReset}>初始化这个群的印象…</button>
      </div>
    </details>
    {status && <p className="impressions-data-status" role="status">{status}</p>}
    <TagVetoMenu sessionId={sessionId} disabled={disabled} openRequest={vetoOpenRequest} renderMenu={false} />

    <dialog className="impressions-data-dialog" ref={exportDialogRef} aria-labelledby="impressions-export-title" onClose={() => setExportOpen(false)} onCancel={() => setExportOpen(false)}>
      <header className="impressions-data-dialog-heading">
        <div><span className="eyebrow">{groupName}</span><h2 id="impressions-export-title">导出印象</h2></div>
        <button className="button button-secondary" type="button" onClick={() => setExportOpen(false)}>关闭</button>
      </header>
      <p className="muted">生成一个 JSON 文件，可用于迁移或留存。</p>
      <div className="impressions-data-options">
        <label><input type="checkbox" checked={labelsIncluded} onChange={(event) => setLabelsIncluded(event.currentTarget.checked)} /><span><strong>标签与一句话印象</strong><small>包含群标签、群友标签和已有摘要。</small></span></label>
        <label><input type="checkbox" checked={subjectsIncluded} onChange={(event) => setSubjectsIncluded(event.currentTarget.checked)} /><span><strong>主题与别名</strong><small>带上印象中使用的主题词典。</small></span></label>
        <label><input type="checkbox" checked={vetoesIncluded} onChange={(event) => setVetoesIncluded(event.currentTarget.checked)} /><span><strong>否决记录</strong><small>导入到别处后，删掉的标签也不会被重新学回来。</small></span></label>
        <label><input type="checkbox" checked={activityIncluded} onChange={(event) => setActivityIncluded(event.currentTarget.checked)} /><span><strong>出没统计</strong><small>可以从聊天记录重新算，一般不用带。</small></span></label>
        <label><input type="checkbox" checked={l1Included} onChange={(event) => setL1Included(event.currentTarget.checked)} /><span><strong>私聊里了解到的事（L1）</strong><small>只在确认文件不会转发时勾选；L0 永远不导出。</small></span></label>
      </div>
      {error && <p className="notice notice-warn" role="alert">{error}</p>}
      <footer className="impressions-data-dialog-footer">
        <button className="button button-secondary" type="button" disabled={busy} onClick={() => setExportOpen(false)}>取消</button>
        <button className="button button-primary" type="button" disabled={busy} onClick={() => void exportData()}>{busy ? '正在导出…' : '导出'}</button>
      </footer>
    </dialog>

    <dialog className="impressions-data-dialog" ref={importDialogRef} aria-labelledby="impressions-import-title" onClose={() => setImportOpen(false)} onCancel={() => setImportOpen(false)}>
      <header className="impressions-data-dialog-heading">
        <div><span className="eyebrow">{groupName}</span><h2 id="impressions-import-title">导入预览</h2></div>
        <button className="button button-secondary" type="button" onClick={() => setImportOpen(false)}>关闭</button>
      </header>
      <label className="impressions-data-file">
        <span>选择 Aquarium 印象 JSON</span>
        <input ref={fileInputRef} type="file" accept="application/json,.json" onChange={onFileChange} disabled={busy} />
      </label>
      {fileName && <p className="impressions-data-file-name mono">{fileName}</p>}
      {busy && <p className="muted" aria-live="polite">正在读取并检查文件…</p>}
      {preview && <>
        <dl className="impressions-import-counts">
          <div><dt>新增标签</dt><dd>{preview.added}</dd></div>
          <div><dt>与现有冲突</dt><dd>{preview.conflicts}</dd></div>
          <div><dt>否决记录</dt><dd>{preview.vetoes}</dd></div>
          <div><dt>一句话印象</dt><dd>{preview.summaries} 人</dd></div>
        </dl>
        <fieldset className="impressions-import-modes">
          <legend>标签冲突处理</legend>
          <label><input type="radio" name="impressions-import-mode" checked={mode === 'merge'} onChange={() => setMode('merge')} /><span><strong>合并</strong><small>保留现有内容，只补上新的。</small></span></label>
          <label><input type="radio" name="impressions-import-mode" checked={mode === 'overwrite'} onChange={() => setMode('overwrite')} /><span><strong>覆盖</strong><small>以文件为准；现有锁定标签始终不动。</small></span></label>
        </fieldset>
      </>}
      {error && <p className="notice notice-warn" role="alert">{error}</p>}
      <footer className="impressions-data-dialog-footer">
        <button className="button button-secondary" type="button" disabled={busy} onClick={() => setImportOpen(false)}>取消</button>
        <button className="button button-primary" type="button" disabled={busy || !preview} onClick={() => void importData()}>{busy ? '正在导入…' : '导入'}</button>
      </footer>
    </dialog>

    <dialog className="impressions-data-dialog impressions-reset-dialog" ref={resetDialogRef} aria-labelledby="impressions-reset-title" onClose={() => setResetOpen(false)} onCancel={() => setResetOpen(false)}>
      <header className="impressions-data-dialog-heading">
        <div><span className="eyebrow">{groupName}</span><h2 id="impressions-reset-title">初始化这个群的印象</h2></div>
        <button className="button button-secondary" type="button" onClick={() => setResetOpen(false)}>关闭</button>
      </header>
      <p>会清空：群标签 {resetCounts?.groupTags ?? '—'} 条、群友标签 {resetCounts?.memberTags ?? '—'} 条、否决记录 {resetCounts?.vetoes ?? '—'} 条和整理水位线。</p>
      <p className="muted">会保留：聊天记录、出没统计、好感度、私聊记忆、身份与关系、共享的一句话印象和主题别名。</p>
      <p className="impressions-data-backup-note">✓ 会先自动导出一份备份到 <code>data/backups/</code></p>
      <label className="impressions-reset-confirm"><span>输入群名确认：<strong>{groupName}</strong></span><input value={confirmation} onChange={(event) => setConfirmation(event.currentTarget.value)} autoComplete="off" /></label>
      {error && <p className="notice notice-warn" role="alert">{error}</p>}
      <footer className="impressions-data-dialog-footer">
        <button className="button button-secondary" type="button" disabled={busy} onClick={() => setResetOpen(false)}>取消</button>
        <button className="button button-warn" type="button" disabled={busy || !resetCounts || confirmation !== groupName} onClick={() => void resetData()}>{busy ? '正在备份并初始化…' : '备份并初始化'}</button>
      </footer>
    </dialog>
  </>;
}
