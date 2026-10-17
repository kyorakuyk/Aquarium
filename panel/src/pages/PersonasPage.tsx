import { useEffect, useRef, useState, type DragEvent } from 'react';
import { apiRequest, type PanelStatus, type PersonaTraits } from '../api.ts';
import type { PageId } from '../components/Sidebar.tsx';
import { parsePersonaTraits, updatePersonaMarkdownTraits } from '../persona-traits.ts';

interface PersonaCard {
  id: string;
  filename: string;
  source: 'data' | 'built-in';
}

const ZERO_TRAITS: PersonaTraits = { order: 0, morality: 0, talk: 0, mind: 0 };
const TRAIT_FIELDS: Array<{ key: keyof PersonaTraits; title: string; low: string; high: string }> = [
  { key: 'order', title: '规矩', low: '守序', high: '混沌' },
  { key: 'morality', title: '善意', low: '善良', high: '邪恶' },
  { key: 'talk', title: '话量', low: '文静', high: '话痨' },
  { key: 'mind', title: '思维', low: '理性', high: '情感' },
];

function renderPlaceholders(line: string) {
  return line.split(/(\{\{[^}]+\}\})/gu).map((part, index) => part.startsWith('{{') && part.endsWith('}}')
    ? <mark className="placeholder-highlight" key={`${part}-${index}`}>{part}</mark>
    : <span key={`${part}-${index}`}>{part}</span>);
}

function MarkdownPreview({ markdown }: { markdown: string }) {
  return (
    <div className="markdown-preview">
      {markdown.split(/\r?\n/u).map((line, index) => {
        const heading = /^(#{1,3})\s+(.*)$/u.exec(line);
        if (heading) {
          const level = heading[1]?.length ?? 1;
          const text = renderPlaceholders(heading[2] ?? '');
          if (level === 1) return <h2 key={index}>{text}</h2>;
          if (level === 2) return <h3 key={index}>{text}</h3>;
          return <h4 key={index}>{text}</h4>;
        }
        return <p key={index}>{line ? renderPlaceholders(line) : <br />}</p>;
      })}
    </div>
  );
}

export function PersonasPage({ onNavigate }: { onNavigate: (page: PageId) => void }) {
  const [personas, setPersonas] = useState<PersonaCard[]>([]);
  const [accounts, setAccounts] = useState<PanelStatus['accounts']>([]);
  const [selectedId, setSelectedId] = useState('');
  const [markdown, setMarkdown] = useState('');
  const [traits, setTraits] = useState<PersonaTraits>(ZERO_TRAITS);
  const [traitsInvalid, setTraitsInvalid] = useState(false);
  const [newId, setNewId] = useState('');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  async function loadLibrary(preferred?: string) {
    const [items, status] = await Promise.all([
      apiRequest<PersonaCard[]>('/api/personas'),
      apiRequest<PanelStatus>('/api/status'),
    ]);
    setPersonas(items);
    setAccounts(status.accounts);
    const next = preferred ?? selectedId;
    if (!items.some((item) => item.id === next)) setSelectedId(items[0]?.id ?? '');
  }

  useEffect(() => {
    void loadLibrary().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : '读取人设失败'));
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setMarkdown('');
      setTraits({ ...ZERO_TRAITS });
      setTraitsInvalid(false);
      return;
    }
    void apiRequest<{ markdown: string; traits: PersonaTraits | null }>(`/api/personas/${encodeURIComponent(selectedId)}`)
      .then((result) => {
        setMarkdown(result.markdown);
        const parsed = result.traits ?? parsePersonaTraits(result.markdown);
        setTraits(parsed ?? { ...ZERO_TRAITS });
        setTraitsInvalid(parsed === null);
        setSaved(false);
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : '读取人设失败'));
  }, [selectedId]);

  async function save() {
    if (!selectedId) return;
    setBusy(true);
    setError('');
    try {
      await apiRequest(`/api/personas/${encodeURIComponent(selectedId)}`, {
        method: 'PUT', body: JSON.stringify({ markdown, traits }),
      });
      const savedPersona = await apiRequest<{ markdown: string; traits: PersonaTraits | null }>(`/api/personas/${encodeURIComponent(selectedId)}`);
      setMarkdown(savedPersona.markdown);
      setTraits(savedPersona.traits ?? { ...ZERO_TRAITS });
      setTraitsInvalid(savedPersona.traits === null);
      setSaved(true);
      await loadLibrary(selectedId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  async function importFile(file: File) {
    setBusy(true);
    setError('');
    try {
      const text = await file.text();
      const imported = await apiRequest<{ id: string }>('/api/personas/import', {
        method: 'POST', body: JSON.stringify({ filename: file.name, markdown: text }),
      });
      await loadLibrary(imported.id);
      setSelectedId(imported.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '导入失败');
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function createPersona() {
    const id = newId.trim();
    if (!/^[a-z0-9_-]+$/u.test(id)) {
      setError('人设 ID 只能包含小写英文字母、数字、下划线和连字符。');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await apiRequest(`/api/personas/${encodeURIComponent(id)}`, {
        method: 'PUT', body: JSON.stringify({ markdown: `# ${id}\n\n{{name}} 是一个友善、自然的聊天伙伴。` }),
      });
      setNewId('');
      await loadLibrary(id);
      setSelectedId(id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '新建失败');
    } finally {
      setBusy(false);
    }
  }

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    const file = event.dataTransfer.files[0];
    if (file && file.name.toLowerCase().endsWith('.md')) void importFile(file);
    else setError('请拖入 Markdown（.md）文件。');
  }

  function changeMarkdown(value: string) {
    setMarkdown(value);
    const parsed = parsePersonaTraits(value);
    if (parsed) {
      setTraits(parsed);
      setTraitsInvalid(false);
    } else {
      setTraitsInvalid(true);
    }
    setSaved(false);
  }

  function changeTrait(field: keyof PersonaTraits, value: number) {
    const updated = { ...traits, [field]: value };
    setTraits(updated);
    setMarkdown(updatePersonaMarkdownTraits(markdown, updated));
    setTraitsInvalid(false);
    setSaved(false);
  }

  const selected = personas.find((persona) => persona.id === selectedId);
  const boundAccounts = accounts.filter((account) => account.persona === selectedId);

  return (
    <div className="page">
      <header className="page-header page-header-actions">
        <div><h1>人设</h1><p className="page-description">把角色的语气、边界和背景写在这里。</p></div>
        <div className="header-actions">
          <button className="button button-secondary" type="button" onClick={() => fileInput.current?.click()}>导入 Markdown</button>
          <button className="button button-primary" type="button" onClick={() => setNewId(newId || 'new-persona')}>新建人设</button>
        </div>
      </header>
      {error && <div className="notice notice-warn" role="alert">{error}</div>}
      {newId && <div className="new-persona-row"><label htmlFor="new-persona-id">新建 ID</label><input id="new-persona-id" value={newId} onChange={(event) => setNewId(event.currentTarget.value)} /><button className="button button-primary" type="button" disabled={busy} onClick={() => void createPersona()}>创建</button><button className="text-button" type="button" onClick={() => setNewId('')}>取消</button></div>}
      <input id="persona-file" ref={fileInput} className="visually-hidden" type="file" accept=".md,text/markdown" onChange={(event) => { const file = event.currentTarget.files?.[0]; if (file) void importFile(file); }} />
      <div className="persona-workspace">
        <section className="persona-library panel-card">
          <div className="section-heading"><div><h2>人设库</h2><p className="muted">{personas.length} 个 Markdown 文件</p></div></div>
          <div className="persona-list">
            {personas.map((persona) => {
              const bound = accounts.filter((account) => account.persona === persona.id);
              return <button className={`persona-list-item ${selectedId === persona.id ? 'is-selected' : ''}`} type="button" key={persona.id} onClick={() => setSelectedId(persona.id)}>
                <strong>{persona.id}</strong><span className="mono muted">{persona.filename}</span>
                <span className="persona-summary">{bound.length ? `账号 ${bound.map((account) => account.account).join('、')} 在用` : persona.source === 'built-in' ? '内置人设' : '未绑定账号'}</span>
              </button>;
            })}
          </div>
          <label className="file-drop" htmlFor="persona-file" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
            <strong>把 .md 文件拖到这里导入</strong><span className="muted">或使用右上角按钮选择文件</span>
          </label>
        </section>
        <section className="persona-editor panel-card">
          {!selected && <div className="empty-state">选择或导入一个人设开始编辑。</div>}
          {selected && <>
            <div className="editor-heading">
              <div><h2>{selected.id}</h2><span className="mono muted">{selected.filename}</span></div>
              <div className="editor-actions"><span className="save-state">{busy ? '保存中…' : saved ? '已保存' : selected.source === 'built-in' ? '内置副本' : '未保存更改'}</span><button className="button button-primary" type="button" disabled={busy} onClick={() => void save()}>保存</button></div>
            </div>
            <div className="binding-row"><label htmlFor="persona-account">绑定账号</label><select id="persona-account" value={boundAccounts[0]?.account ?? ''} disabled aria-describedby="binding-note"><option value="">尚无账号使用</option>{accounts.map((account) => <option key={account.account} value={account.account}>QQ {account.account} · {account.persona}.md</option>)}</select><span id="binding-note" className="muted">账号绑定由配置文件管理</span></div>
            <section className="persona-traits" aria-labelledby="persona-traits-title">
              <div className="persona-traits-heading"><h3 id="persona-traits-title">性格底色</h3><span className="muted">0 表示不额外强调；点击档位后随人设保存。</span></div>
              {traitsInvalid && <p className="notice notice-warn" role="alert">当前 YAML 性格文件头无效；选择档位并保存可重写性格文件头，Markdown 正文会保留。</p>}
              <div className="persona-trait-grid">
                {TRAIT_FIELDS.map((field) => (
                  <div className="persona-trait-field" key={field.key}>
                    <div className="persona-trait-label"><strong>{field.title}</strong><span className="muted">{field.low} ←　→ {field.high}</span></div>
                    <div className="trait-segments" role="radiogroup" aria-label={`${field.title}：${field.low} 到 ${field.high}`}>
                      {[-2, -1, 0, 1, 2].map((value) => (
                        <button
                          className={traits[field.key] === value ? 'is-selected' : ''}
                          type="button"
                          role="radio"
                          aria-checked={traits[field.key] === value}
                          aria-label={`${field.title} ${value > 0 ? `+${value}` : value}`}
                          key={value}
                          disabled={busy}
                          onClick={() => changeTrait(field.key, value)}
                        >{value > 0 ? `+${value}` : value}</button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
            <div className="editor-columns">
              <label className="editor-column"><span className="small-heading">Markdown</span><textarea className="markdown-input mono" value={markdown} onChange={(event) => changeMarkdown(event.currentTarget.value)} spellCheck={false} aria-label="Markdown 人设内容" /></label>
              <div className="editor-column"><div className="small-heading">预览</div><div className="preview-surface"><MarkdownPreview markdown={markdown} /></div></div>
            </div>
            <div className="editor-footer"><span className="muted">{boundAccounts.length ? `当前绑定：${boundAccounts.map((account) => `QQ ${account.account}`).join('、')}` : '尚无账号绑定此人设'}</span><button className="text-button" type="button" onClick={() => onNavigate('sandbox')} title="试聊将使用所选会话当前配置的人设">用当前会话试聊 →</button></div>
          </>}
        </section>
      </div>
    </div>
  );
}
