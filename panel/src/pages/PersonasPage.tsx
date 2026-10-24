import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { apiRequest, type PanelStatus } from '../api.ts';
import type { PageId } from '../components/Sidebar.tsx';
import { personaEditorViewClass } from '../persona-editor-view.ts';
import { readPersonaPageTabs, writePersonaPageTabs } from '../persona-page-tabs.ts';
import { redactSensitiveText } from '../../../src/core/impressions/sensitive-text.ts';
import { hasPersonaIdCollision, normalizePersonaId, validPersonaId } from '../../../src/persona/persona-id.ts';
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
import { PersonaEditorToolbar } from './PersonaEditorToolbar.tsx';
import { PersonaFields } from './PersonaFields.tsx';
import { PersonaLibraryToolbar, type PersonaCard } from './PersonaLibraryToolbar.tsx';
import { PersonaPreview, type PersonaPreviewResult } from './PersonaPreview.tsx';

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

export function PersonasPage({ onNavigate }: { onNavigate: (page: PageId) => void }) {
  const [personas, setPersonas] = useState<PersonaCard[]>([]);
  const [accounts, setAccounts] = useState<PanelStatus['accounts']>([]);
  const [selectedId, setSelectedId] = useState('');
  const [previewAccountId, setPreviewAccountId] = useState<number | null>(null);
  const [form, setForm] = useState<PersonaSectionsForm>(() => emptyPersonaSections());
  const [sourceText, setSourceText] = useState(() => buildSections(emptyPersonaSections()));
  const [savedMarkdown, setSavedMarkdown] = useState<string | null>(null);
  const [pageTabs, setPageTabs] = useState(readPersonaPageTabs);
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
  const [bindingMessage, setBindingMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [newId, setNewId] = useState('');
  const [importDraft, setImportDraft] = useState<PersonaImportDraft | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  const [fileDragActive, setFileDragActive] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const fileDragDepth = useRef(0);

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
  const previewAccount = accounts.find((account) => account.account === previewAccountId)
    ?? boundAccounts[0]
    ?? accounts[0];
  const previewName = previewAccount?.name.trim() || '水族箱';

  useEffect(() => {
    writePersonaPageTabs(pageTabs);
  }, [pageTabs]);

  useEffect(() => {
    setPreviewAccountId(null);
    setBindingMessage('');
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
      const markdown = buildSections(empty);
      setForm(empty);
      setSavedMarkdown(markdown);
      setSourceText(markdown);
      setSourceError('');
      setViewMode('preview');
      setDirty(false);
      setSaved(false);
      return;
    }
    setSavedMarkdown(null);
    let active = true;
    void apiRequest<PersonaDocument>(`/api/personas/${encodeURIComponent(selectedId)}`)
      .then((document) => {
        if (!active) return;
        setSavedMarkdown(document.markdown);
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

  function restoreLastSaved() {
    if (!dirty || savedMarkdown === null) return;
    if (!window.confirm('放弃当前未保存更改，并还原到上次保存的内容？')) return;
    setSourceText(savedMarkdown);
    setActiveBlockId('');
    setError('');
    setSaved(false);
    setDirty(false);
    try {
      setForm(parseSections(savedMarkdown));
      setSourceError('');
      setViewMode('preview');
    } catch {
      setForm(emptyPersonaSections());
      setSourceError('源文件 YAML 或 traits 格式无效；请在源文件视图修复后再使用表单。');
      setViewMode('source');
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
      setSavedMarkdown(markdown);
      setVersionRefreshKey((current) => current + 1);
      setSourceText(markdown);
      setDirty(false);
      setSaved(true);
      const savedDocument = await apiRequest<PersonaDocument>(`/api/personas/${encodeURIComponent(selectedId)}`);
      const savedForm = parseSections(savedDocument.markdown);
      setSavedMarkdown(savedDocument.markdown);
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
    const id = normalizePersonaId(newId);
    if (!validPersonaId(id)) {
      setError('人设 ID 只能包含字母、数字、下划线和连字符，且长度为 1–40 个字符。');
      return;
    }
    if (hasPersonaIdCollision(personas.map((persona) => persona.id), id)) {
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

  async function bindSelectedAccountPersona() {
    if (!selectedId || !previewAccount || busy) return;
    if (dirty && !window.confirm('当前人设有未保存更改；切换当前眷属的人设不会保存这些更改，仍要继续吗？')) return;
    setBusy(true);
    setError('');
    setBindingMessage('');
    try {
      const updated = await apiRequest<{ account: number; persona: string }>(
        `/api/accounts/${previewAccount.account}/persona`,
        { method: 'PUT', body: JSON.stringify({ persona: selectedId }) },
      );
      setAccounts((current) => current.map((account) => account.account === updated.account
        ? { ...account, persona: updated.persona }
        : account));
      setBindingMessage('重启机器人后生效');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '切换人设失败');
    } finally {
      setBusy(false);
    }
  }

  function carriesFiles(event: DragEvent<HTMLDivElement>): boolean {
    return Array.from(event.dataTransfer.types).includes('Files');
  }

  function onPageDragEnter(event: DragEvent<HTMLDivElement>) {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    fileDragDepth.current += 1;
    setFileDragActive(true);
  }

  function onPageDragOver(event: DragEvent<HTMLDivElement>) {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }

  function onPageDragLeave(event: DragEvent<HTMLDivElement>) {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    fileDragDepth.current = Math.max(0, fileDragDepth.current - 1);
    if (fileDragDepth.current === 0) setFileDragActive(false);
  }

  function onPageDrop(event: DragEvent<HTMLDivElement>) {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    fileDragDepth.current = 0;
    setFileDragActive(false);
    const file = event.dataTransfer.files[0];
    if (file && !busy) void importFile(file);
  }

  const selected = personas.find((persona) => persona.id === selectedId);
  const saveLabel = busy ? '处理中…' : dirty ? '有未保存更改' : saved ? '已保存' : '已同步';

  return (
    <div
      className={['page', 'personas-page', personaEditorViewClass(viewMode)].filter(Boolean).join(' ')}
      onDragEnter={onPageDragEnter}
      onDragOver={onPageDragOver}
      onDragLeave={onPageDragLeave}
      onDrop={onPageDrop}
    >
      <PersonaLibraryToolbar
        personas={personas}
        accounts={accounts}
        selectedId={selectedId}
        loading={loading}
        busy={busy}
        onSelect={selectPersona}
        onImport={() => fileInput.current?.click()}
        onNew={() => setNewId((current) => current || 'new-persona')}
      />
      <input id="persona-file" ref={fileInput} className="visually-hidden" type="file" accept=".md,text/markdown" onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) void importFile(file); }} />
      {error && <div className="notice notice-warn persona-page-notice" role="alert">{error}</div>}
      {newId && <div className="new-persona-row"><label htmlFor="new-persona-id">新建 ID</label><input id="new-persona-id" value={newId} onChange={(event) => setNewId(event.currentTarget.value)} /><button className="button button-primary" type="button" disabled={busy} onClick={() => void createPersona()}>创建</button><button className="text-button" type="button" disabled={busy} onClick={() => setNewId('')}>取消</button></div>}

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
          <PersonaEditorToolbar
            title={selected.id}
            detail={`${selected.source === 'built-in' ? '内置人设副本' : selected.filename} · ${boundAccounts.length ? `已绑定眷属：QQ ${boundAccounts.map((account) => account.account).join('、')}` : '尚未绑定眷属'}`}
            saveLabel={saveLabel}
            dirty={dirty}
            busy={busy}
            canRestore={dirty && savedMarkdown !== null}
            canBind={Boolean(previewAccount)}
            canSave={dirty && !Boolean(sourceError)}
            activeTab={pageTabs.page}
            onRestore={restoreLastSaved}
            onTryChat={() => onNavigate('sandbox')}
            onBind={() => { void bindSelectedAccountPersona(); }}
            onSave={() => { void save(); }}
            onTabChange={(page) => setPageTabs((current) => ({ ...current, page }))}
          />
          {bindingMessage && <p className="muted" role="status">{bindingMessage}</p>}
          <div className="persona-workspace-v2">
            <div className="persona-main-tab-panel">
              <PersonaFields
                form={form}
                onChange={updateForm}
                onFocus={setActiveBlockId}
                disabled={busy || Boolean(sourceError)}
                activeTab={pageTabs.page}
                parameterTab={pageTabs.parameter}
                onParameterTabChange={(parameter) => setPageTabs((current) => ({ ...current, parameter }))}
              />
            </div>
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
              previewAccounts={accounts}
              previewAccountId={previewAccount?.account ?? null}
              onPreviewAccountChange={(account) => { setPreviewAccountId(account); setBindingMessage(''); }}
              disabled={busy}
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
      {fileDragActive && <div className="persona-page-drop-overlay" role="status" aria-live="polite"><span>松开以导入 Markdown 文件</span></div>}
    </div>
  );
}
