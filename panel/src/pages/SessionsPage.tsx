import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { apiRequest, patch, type SessionView } from '../api.ts';

type SessionField = 'enabled' | 'mode' | 'nicknames' | 'contextMessages' | 'rate' | 'groupNote';
type RateField = keyof SessionView['effective']['rate'];

function FieldHeading({ title, fields, session, onReset }: {
  title: string;
  fields: SessionField[];
  session: SessionView;
  onReset: (fields: SessionField[]) => void;
}) {
  const overridden = fields.some((field) => session.overrides.includes(field));
  return (
    <div className="field-heading">
      <h3>{title}</h3>
      {overridden
        ? <button className="inherit-button is-overridden" type="button" onClick={() => onReset(fields)}>本群覆盖 · 恢复继承</button>
        : <span className="inherit-label">继承全局</span>}
    </div>
  );
}

function SettingGroup({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`setting-group ${className}`}>{children}</section>;
}

export function SessionsPage() {
  const [sessions, setSessions] = useState<SessionView[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [kind, setKind] = useState<'group' | 'private'>('group');
  const [query, setQuery] = useState('');
  const [nicknames, setNicknames] = useState('');
  const [groupNote, setGroupNote] = useState('');
  const [error, setError] = useState('');
  const [savedAt, setSavedAt] = useState('');
  const [busy, setBusy] = useState(false);

  const selected = sessions.find((item) => item.sessionId === selectedId);
  const visible = useMemo(() => sessions.filter((item) => item.kind === kind
    && `${item.name} ${item.sessionId}`.toLowerCase().includes(query.trim().toLowerCase())), [sessions, kind, query]);

  async function loadSessions(preferredId?: string) {
    const result = await apiRequest<SessionView[]>('/api/sessions');
    setSessions(result);
    const nextId = preferredId ?? selectedId;
    if (!result.some((item) => item.sessionId === nextId)) {
      setSelectedId(result.find((item) => item.kind === kind)?.sessionId ?? result[0]?.sessionId ?? '');
    }
  }

  useEffect(() => {
    void loadSessions().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : '读取会话失败'));
  }, []);

  useEffect(() => {
    if (!selected) return;
    setNicknames(selected.effective.nicknames.join(', '));
    setGroupNote(selected.effective.groupNote);
  }, [selectedId, sessions]);

  async function update(values: Record<string, unknown>, targetId = selected?.sessionId) {
    if (!targetId) return;
    setBusy(true);
    setError('');
    try {
      await patch(`/api/sessions/${encodeURIComponent(targetId)}`, values);
      await loadSessions(targetId);
      setSavedAt(new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date()));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  function restore(fields: SessionField[]) {
    void update(Object.fromEntries(fields.map((field) => [field, null])));
  }

  async function setRate(field: RateField, rawValue: string) {
    const value = rawValue.trim() === '' ? null : Number(rawValue);
    await update({ rate: { [field]: value } });
  }

  const groupCount = sessions.filter((item) => item.kind === 'group').length;
  const friendCount = sessions.filter((item) => item.kind === 'private').length;

  return (
    <div className="page">
      <header className="page-header">
        <h1>会话</h1>
        <p className="page-description">打开开关的会话里，它才会说话。改动立刻生效，不用重启。</p>
      </header>
      {error && <div className="notice notice-warn" role="alert">{error}</div>}
      <div className="session-workspace">
        <section className="session-list-card panel-card">
          <div className="segmented-control" role="group" aria-label="会话类型">
            <button className={kind === 'group' ? 'is-selected' : ''} type="button" onClick={() => setKind('group')}>群聊 <span>{groupCount}</span></button>
            <button className={kind === 'private' ? 'is-selected' : ''} type="button" onClick={() => setKind('private')}>好友 <span>{friendCount}</span></button>
          </div>
          <label className="search-field">
            <span className="visually-hidden">搜索会话</span>
            <input type="search" placeholder="搜索名称或号码" value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
          </label>
          <div className="session-list">
            {visible.map((item) => (
              <div className={`session-row ${selectedId === item.sessionId ? 'is-selected' : ''}`} key={item.sessionId}>
                <button
                  className="session-row-main"
                  type="button"
                  onClick={() => setSelectedId(item.sessionId)}
                  aria-pressed={selectedId === item.sessionId}
                >
                  <span className="avatar-initial">{Array.from(item.name)[0] ?? '会'}</span>
                  <span className="session-row-copy"><strong>{item.name}</strong><span className="mono muted">{item.sessionId}{item.memberCount === undefined ? '' : ` · ${item.memberCount} 人`}</span></span>
                </button>
                <button
                  className={`switch ${item.enabled ? 'is-on' : ''}`}
                  type="button"
                  role="switch"
                  aria-checked={item.enabled}
                  aria-label={`${item.name}${item.enabled ? '已启用' : '已停用'}`}
                  disabled={busy}
                  onClick={() => void update({ enabled: !item.enabled }, item.sessionId)}
                ><span /></button>
                <span className={`override-tag ${item.overrides.length ? 'is-overridden' : ''}`}>{item.overrides.length ? '本群覆盖' : '继承全局'}</span>
              </div>
            ))}
            {visible.length === 0 && <p className="empty-state">没有找到会话。</p>}
          </div>
        </section>

        <section className="session-detail panel-card">
          {!selected && <div className="empty-state">选择一个会话查看设置。</div>}
          {selected && <>
            <div className="detail-title-row">
              <div><div className="eyebrow">{selected.kind === 'group' ? '群聊' : '好友'}</div><h2>{selected.name}</h2><span className={`result-pill ${selected.enabled ? 'result-positive' : 'result-neutral'}`}>{selected.enabled ? '已启用' : '已停用'}</span></div>
              <button className={`switch switch-large ${selected.enabled ? 'is-on' : ''}`} type="button" role="switch" aria-checked={selected.enabled} aria-label="启用会话" disabled={busy} onClick={() => void update({ enabled: !selected.enabled })}><span /></button>
            </div>

            <SettingGroup>
              <FieldHeading title="什么时候说话" fields={['mode']} session={selected} onReset={restore} />
              <div className="mode-grid">
                {[
                  { id: 'mention_only', title: '只在被叫时', note: '可用', disabled: false },
                  { id: 'natural', title: '自然', note: 'M2', disabled: true },
                  { id: 'active', title: '积极', note: 'M2', disabled: true },
                  { id: 'busy', title: '忙碌', note: 'M2', disabled: true },
                ].map((option) => (
                  <button
                    className={`mode-card ${selected.effective.mode === option.id ? 'is-current' : ''}`}
                    key={option.id}
                    type="button"
                    disabled={option.disabled || busy}
                    onClick={() => void update({ mode: option.id })}
                  ><strong>{option.title}</strong><span>{option.note}</span></button>
                ))}
              </div>
            </SettingGroup>

            <SettingGroup>
              <FieldHeading title="叫它的名字" fields={['nicknames']} session={selected} onReset={restore} />
              <label className="field-label" htmlFor="session-nicknames">多个名字用逗号分开</label>
              <input id="session-nicknames" value={nicknames} onChange={(event) => setNicknames(event.currentTarget.value)} onBlur={() => void update({ nicknames: nicknames.split(',').map((name) => name.trim()).filter(Boolean) })} />
            </SettingGroup>

            <SettingGroup>
              <FieldHeading title="在这个群里的补充说明" fields={['groupNote']} session={selected} onReset={restore} />
              <textarea rows={3} value={groupNote} onChange={(event) => setGroupNote(event.currentTarget.value)} onBlur={() => void update({ groupNote })} aria-label="会话补充说明" />
            </SettingGroup>

            <SettingGroup>
              <FieldHeading title="频率与上下文" fields={['rate', 'contextMessages']} session={selected} onReset={restore} />
              <div className="number-grid">
                <label><span>每人每分钟最多</span><input type="number" min="1" value={selected.effective.rate.perUserPerMinute} onBlur={(event) => void setRate('perUserPerMinute', event.currentTarget.value)} onChange={(event) => setSessions((items) => items.map((item) => item.sessionId === selectedId ? { ...item, effective: { ...item.effective, rate: { ...item.effective.rate, perUserPerMinute: Number(event.currentTarget.value) } } } : item))} /></label>
                <label><span>整个群每分钟最多</span><input type="number" min="1" value={selected.effective.rate.perSessionPerMinute} onBlur={(event) => void setRate('perSessionPerMinute', event.currentTarget.value)} onChange={(event) => setSessions((items) => items.map((item) => item.sessionId === selectedId ? { ...item, effective: { ...item.effective, rate: { ...item.effective.rate, perSessionPerMinute: Number(event.currentTarget.value) } } } : item))} /></label>
                <label><span>两次回复至少间隔（秒）</span><input type="number" min="0.1" step="0.1" value={selected.effective.rate.minIntervalSec} onBlur={(event) => void setRate('minIntervalSec', event.currentTarget.value)} onChange={(event) => setSessions((items) => items.map((item) => item.sessionId === selectedId ? { ...item, effective: { ...item.effective, rate: { ...item.effective.rate, minIntervalSec: Number(event.currentTarget.value) } } } : item))} /></label>
                <label><span>参考最近几条</span><input type="number" min="1" value={selected.effective.contextMessages} onBlur={(event) => void update({ contextMessages: Number(event.currentTarget.value) })} onChange={(event) => setSessions((items) => items.map((item) => item.sessionId === selectedId ? { ...item, effective: { ...item.effective, contextMessages: Number(event.currentTarget.value) } } : item))} /></label>
              </div>
            </SettingGroup>
            <div className="save-state" aria-live="polite">{busy ? '正在保存…' : savedAt ? `已自动保存 · ${savedAt}` : '改动会自动保存'}</div>
          </>}
        </section>
      </div>
    </div>
  );
}
