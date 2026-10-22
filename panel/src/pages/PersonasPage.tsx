import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { apiRequest, type PanelStatus } from '../api.ts';
import type { PageId } from '../components/Sidebar.tsx';
import { redactSensitiveText } from '../../../src/core/impressions/sensitive-text.ts';
import {
  buildSections,
  emptyPersonaSections,
  parseSections,
  personaSourceForEditor,
  personaSourceFromEditor,
  syncPersonaFormEdit,
  type PersonaSectionsForm,
} from '../persona-sections.ts';
import { PersonaComparisonDialog } from './PersonaComparisonDialog.tsx';
import { PersonaFields } from './PersonaFields.tsx';
import { PersonaPreview, type PersonaPreviewResult } from './PersonaPreview.tsx';

interface PersonaCard {
  id: string;
  filename: string;
  source: 'data' | 'built-in';
}

interface PersonaDocument {
  markdown: string;
  traits: PersonaSectionsForm['traits'] | null;
}

interface PersonaImportDraft {
  filename: string;
  source: string;
  draft: string;
  form: PersonaSectionsForm;
  mappedCount: number;
  otherCount: number;
}

const personaIdPattern = /^[a-z0-9_-]+$/u;

export function PersonasPage({ onNavigate }: { onNavigate: (page: PageId) => void }) {
  const [personas, setPersonas] = useState<PersonaCard[]>([]);
  const [accounts, setAccounts] = useState<PanelStatus['accounts']>([]);
  const [selectedId, setSelectedId] = useState('');
  const [previewAccountId, setPreviewAccountId] = useState<number | null>(null);
  const [form, setForm] = useState<PersonaSectionsForm>(() => emptyPersonaSections());
  const [sourceText, setSourceText] = useState(() => buildSections(emptyPersonaSections()));
  const [sourceError, setSourceError] = useState('');
  const [viewMode, setViewMode] = useState<'preview' | 'source'>('preview');
  const [activeBlockId, setActiveBlockId] = useState('');
  const [preview, setPreview] = useState<PersonaPreviewResult | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [versionRefreshKey, setVersionRefreshKey] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [newId, setNewId] = useState('');
  const [importDraft, setImportDraft] = useState<PersonaImportDraft | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const loadLibrary = useCallback(async (preferred?: string) => {
    const [items, status] = await Promise.all([
      apiRequest<PersonaCard[]>('/api/personas'),
      apiRequest<PanelStatus>('/api/status'),
    ]);
    setPersonas(items);
    setAccounts(status.accounts);
    setSelectedId((current) => {
      if (preferred && items.some((item) => item.id === preferred)) return preferred;
      if (current && items.some((item) => item.id === current)) return current;
      return items[0]?.id ?? '';
    });
  }, []);

  const boundAccounts = accounts.filter((account) => account.persona === selectedId);
  const previewAccount = boundAccounts.find((account) => account.account === previewAccountId) ?? boundAccounts[0];
  const previewName = previewAccount?.name.trim() || '水族箱';

  useEffect(() => {
    setPreviewAccountId(null);
  }, [selectedId]);

  useEffect(() => {
    let active = true;
    void loadLibrary().catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : '读取人设失败');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [loadLibrary]);

  useEffect(() => {
    setActiveBlockId('');
    if (!selectedId) {
      const empty = emptyPersonaSections();
      setForm(empty);
      setSourceText(buildSections(empty));
      setSourceError('');
      setViewMode('preview');
      setDirty(false);
      setSaved(false);
      return;
    }
    let active = true;
    void apiRequest<PersonaDocument>(`/api/personas/${encodeURIComponent(selectedId)}`)
      .then((document) => {
        if (!active) return;
        setSourceText(document.markdown);
        setDirty(false);
        setSaved(false);
        try {
          setForm(parseSections(document.markdown));
          setSourceError('');
          setViewMode('preview');
        } catch {
          setForm(emptyPersonaSections());
          setSourceError('源文件 YAML 或 traits 格式无效；请在源文件视图修复后再使用表单。');
          setViewMode('source');
        }
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : '读取人设失败');
      });
    return () => { active = false; };
  }, [selectedId]);

  const previewMarkdown = useMemo(() => buildSections(form), [form]);
  useEffect(() => {
    if (sourceError) {
      setPreview(null);
      setPreviewBusy(false);
      setPreviewError('');
      return;
    }
    let active = true;
    const timer = setTimeout(() => {
      setPreviewBusy(true);
      setPreviewError('');
      void apiRequest<PersonaPreviewResult>('/api/personas/preview', {
        method: 'POST',
        body: JSON.stringify({ content: previewMarkdown, name: previewName }),
      }).then((result) => {
        if (active) setPreview(result);
      }).catch((reason: unknown) => {
        if (active) setPreviewError(reason instanceof Error ? reason.message : '预览失败');
      }).finally(() => {
        if (active) setPreviewBusy(false);
      });
    }, 300);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [previewMarkdown, previewName, sourceError]);

  function updateForm(next: PersonaSectionsForm) {
    const synchronized = syncPersonaFormEdit(next, viewMode === 'source');
    setForm(synchronized.form);
    if (synchronized.sourceText !== undefined) {
      setSourceText(synchronized.sourceText);
      setSourceError('');
    }
    setDirty(true);
    setSaved(false);
    setError('');
  }

  function changeSource(value: string) {
    const markdown = personaSourceFromEditor(value);
    setSourceText(markdown);
    setDirty(true);
    setSaved(false);
    setError('');
    try {
      setForm(parseSections(markdown));
      setSourceError('');
    } catch {
      setSourceError('Markdown 或 YAML 暂不可解析；修正后即可切回表单和预览。');
    }
  }

  function loadVersionIntoEditor(markdown: string) {
    setSourceText(markdown);
    setDirty(true);
    setSaved(false);
    setError('');
    setActiveBlockId('');
    try {
      setForm(parseSections(markdown));
      setSourceError('');
      setViewMode('preview');
    } catch {
      setSourceError('该版本的 Markdown 或 YAML 暂不可解析；请在源文件中修正后再保存。');
      setViewMode('source');
    }
  }

  function changeViewMode(next: 'preview' | 'source') {
    if (next === viewMode) return;
    if (next === 'source') {
      setSourceText(buildSections(form));
      setSourceError('');
      setViewMode('source');
      return;
    }
    try {
      const parsed = parseSections(sourceText);
      setForm(parsed);
      setSourceError('');
      setViewMode('preview');
    } catch {
      setSourceError('Markdown 或 YAML 暂不可解析；请修复源文件后再切回预览。');
    }
  }

  async function save() {
    if (!selectedId || busy || sourceError) return;
    let markdown: string;
    try {
      if (viewMode === 'source') {
        setForm(parseSections(sourceText));
        markdown = sourceText;
      } else {
        markdown = buildSections(form);
      }
    } catch {
      setSourceError('Markdown 或 YAML 暂不可解析；请修复后再保存。');
      setViewMode('source');
      return;
    }
    setBusy(true);
    setError('');
    let savedToServer = false;
    try {
      await apiRequest(`/api/personas/${encodeURIComponent(selectedId)}`, {
        method: 'PUT', body: JSON.stringify({ markdown }),
      });
      savedToServer = true;
      setVersionRefreshKey((current) => current + 1);
      setSourceText(markdown);
      setDirty(false);
      setSaved(true);
      const savedDocument = await apiRequest<PersonaDocument>(`/api/personas/${encodeURIComponent(selectedId)}`);
      const savedForm = parseSections(savedDocument.markdown);
      setForm(savedForm);
      setSourceText(savedDocument.markdown);
      setSourceError('');
      await loadLibrary(selectedId);
    } catch (reason) {
      setError(savedToServer ? '人设已保存，但后续同步未完成。' : reason instanceof Error ? reason.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  async function importFile(file: File) {
    if (!file.name.toLowerCase().endsWith('.md')) {
      setError('请导入 Markdown（.md）文件。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const text = await file.text();
      const imported = await apiRequest<{ draft: string; mappedCount: number; otherCount: number }>('/api/personas/import', {
        method: 'POST', body: JSON.stringify({ filename: file.name, text }),
      });
      setImportDraft({ filename: file.name, source: text, draft: imported.draft, form: parseSections(imported.draft), mappedCount: imported.mappedCount, otherCount: imported.otherCount });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '导入失败');
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  function acceptImport() {
    if (!importDraft) return;
    if (!selectedId) {
      setError('请先创建或选择一个人设，再接受导入草稿。');
      return;
    }
    setForm(importDraft.form);
    setSourceText(importDraft.draft);
    setSourceError('');
    setViewMode('preview');
    setDirty(true);
    setSaved(false);
    setImportDraft(null);
    setCompareOpen(false);
    setError('');
  }

  function selectPersona(id: string) {
    if (id === selectedId) return;
    if (dirty && !window.confirm('切换人设会放弃当前未保存更改，仍要继续吗？')) return;
    setSelectedId(id);
  }

  async function createPersona() {
    const id = newId.trim();
    if (!personaIdPattern.test(id)) {
      setError('人设 ID 只能包含小写英文字母、数字、下划线和连字符。');
      return;
    }
    if (personas.some((persona) => persona.id === id)) {
      setError('这个人设 ID 已存在。');
      return;
    }
    if (dirty && !window.confirm('新建人设会放弃当前未保存更改，仍要继续吗？')) return;
    const newForm = emptyPersonaSections();
    newForm.introduction = '我是一个友善、自然的聊天伙伴。';
    const markdown = buildSections(newForm);
    setBusy(true);
    setError('');
    try {
      await apiRequest(`/api/personas/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ markdown }) });
      setNewId('');
      setDirty(false);
      setSaved(false);
      await loadLibrary(id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '新建失败');
    } finally {
      setBusy(false);
    }
  }

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file) void importFile(file);
  }

  const selected = personas.find((persona) => persona.id === selectedId);
  const saveLabel = busy ? '处理中…' : dirty ? '未保存更改' : saved ? '已保存' : '已同步';

  return (
    <div className="page personas-page">
      <header className="page-header page-header-actions">
        <div><h1>人设</h1><p className="page-description">整理角色背景、语气与边界，并核对实际注入内容。</p></div>
        <div className="header-actions">
          <button className="button button-secondary" type="button" disabled={busy} onClick={() => fileInput.current?.click()}>导入 Markdown</button>
          <button className="button button-primary" type="button" disabled={busy} onClick={() => setNewId((current) => current || 'new-persona')}>新建人设</button>
        </div>
      </header>
      <input ref={fileInput} className="visually-hidden" type="file" accept=".md,text/markdown" onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) void importFile(file); }} />
      {error && <div className="notice notice-warn persona-page-notice" role="alert">{error}</div>}
      {newId && <div className="new-persona-row"><label htmlFor="new-persona-id">新建 ID</label><input id="new-persona-id" value={newId} onChange={(event) => setNewId(event.currentTarget.value)} /><button className="button button-primary" type="button" disabled={busy} onClick={() => void createPersona()}>创建</button><button className="text-button" type="button" disabled={busy} onClick={() => setNewId('')}>取消</button></div>}

      <div className="persona-library-row" role="tablist" aria-label="人设库">
        {personas.map((persona) => {
          const bound = accounts.filter((account) => account.persona === persona.id);
          return (
            <button
              className={`persona-library-chip ${selectedId === persona.id ? 'is-selected' : ''}`}
              type="button"
              role="tab"
              aria-selected={selectedId === persona.id}
              key={persona.id}
              disabled={busy}
              onClick={() => selectPersona(persona.id)}
            >
              <strong>{persona.id}</strong><span className="mono">{persona.filename}</span>
              {bound.length > 0 && <small>在用 · {bound.length}</small>}
            </button>
          );
        })}
        {!loading && personas.length === 0 && <p className="muted">还没有人设，先创建一个。</p>}
        {loading && <p className="muted">正在读取人设库…</p>}
      </div>
      <label className="persona-import-drop" htmlFor="persona-file" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
        拖入 .md 文件，或点击“导入 Markdown”
      </label>

      {importDraft && (
        <section className="persona-import-banner" aria-label="人设导入草稿">
          <div><strong>“{redactSensitiveText(importDraft.filename)}”已整理好</strong><p>拆进了 {importDraft.mappedCount} 个表单项，{importDraft.otherCount} 段放进了“其他小节”。确认前不会保存。</p></div>
          <div className="persona-import-actions">
            <button className="button button-secondary" type="button" disabled={busy} onClick={() => setCompareOpen(true)}>逐项对照</button>
            <button className="text-button" type="button" disabled={busy} onClick={() => { setImportDraft(null); setCompareOpen(false); }}>放弃</button>
            <button className="button button-primary" type="button" disabled={busy || !selectedId} onClick={acceptImport}>接受</button>
          </div>
        </section>
      )}

      {selected ? (
        <>
          <div className="persona-editor-heading">
            <div><h2>{selected.id}</h2><p className="muted">{selected.source === 'built-in' ? '内置人设副本' : selected.filename} · {boundAccounts.length ? `绑定 QQ ${boundAccounts.map((account) => account.account).join('、')}` : '尚无账号绑定'}</p></div>
            <div className="persona-save-actions"><span className={dirty ? 'is-dirty' : ''}>{saveLabel}</span><button className="button button-primary" type="button" disabled={busy || !dirty || Boolean(sourceError)} onClick={() => void save()}>保存</button></div>
          </div>
          <div className="persona-workspace-v2">
            <PersonaFields form={form} onChange={updateForm} onFocus={setActiveBlockId} disabled={busy || Boolean(sourceError)} />
            <PersonaPreview
              mode={viewMode}
              onModeChange={changeViewMode}
              preview={preview}
              previewBusy={previewBusy}
              previewError={previewError}
              activeBlockId={activeBlockId}
              sourceText={personaSourceForEditor(sourceText)}
              sourceError={sourceError}
              onSourceChange={changeSource}
              previewAccounts={boundAccounts}
              previewAccountId={previewAccount?.account ?? null}
              onPreviewAccountChange={setPreviewAccountId}
              disabled={busy}
              onTryChat={() => onNavigate('sandbox')}
              personaId={selected.id}
              versionRefreshKey={versionRefreshKey}
              onRestoreVersion={loadVersionIntoEditor}
            />
          </div>
        </>
      ) : (
        <div className="persona-empty panel-card">{loading ? '正在读取人设…' : '选择或创建一个人设开始编辑。'}</div>
      )}

      <PersonaComparisonDialog
        open={compareOpen && Boolean(importDraft)}
        filename={importDraft?.filename ?? ''}
        source={importDraft?.source ?? ''}
        form={importDraft?.form ?? form}
        onClose={() => setCompareOpen(false)}
      />
    </div>
  );
}
