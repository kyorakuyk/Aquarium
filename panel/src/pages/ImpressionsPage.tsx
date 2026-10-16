import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { apiRequest, patch, post, type ImpressionsView, type SessionView, type TagStatus, type TagView } from '../api.ts';

const STATUS_LABELS: Record<TagStatus, string> = {
  candidate: '候选',
  confirmed: '已确认',
  rejected: '已否决',
  superseded: '被推翻',
};

const STATUS_CLASS: Record<TagStatus, string> = {
  candidate: 'tag-candidate',
  confirmed: 'tag-confirmed',
  rejected: 'tag-rejected',
  superseded: 'tag-superseded',
};

function formatTime(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(value);
}

function TagRow({ tag, busy, onAction, onRename }: {
  tag: TagView;
  busy: boolean;
  onAction: (id: number, status: TagStatus) => void;
  onRename: (id: number, text: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tag.text);

  return (
    <div className="tag-row">
      <div className="tag-main">
        {editing
          ? <input
            className="tag-rename"
            value={draft}
            maxLength={16}
            aria-label="修改标签文字"
            onChange={(event) => setDraft(event.currentTarget.value)}
          />
          : <strong className="tag-text">{tag.text}</strong>}
        <span className={`status-pill ${STATUS_CLASS[tag.status]}`}>{STATUS_LABELS[tag.status]}</span>
        {tag.source === 'manual' && <span className="muted">手动</span>}
        <span className="muted mono">样本 {tag.samples} · 激活 {(tag.activation * 100).toFixed(0)}%</span>
      </div>
      <div className="tag-actions">
        {editing ? (
          <>
            <button className="text-button" type="button" disabled={busy || draft.trim().length === 0} onClick={() => { onRename(tag.id, draft.trim()); setEditing(false); }}>保存</button>
            <button className="text-button" type="button" onClick={() => setEditing(false)}>取消</button>
          </>
        ) : (
          <>
            {tag.status !== 'confirmed' && <button className="text-button" type="button" disabled={busy} onClick={() => onAction(tag.id, 'confirmed')}>确认</button>}
            {tag.status !== 'rejected' && <button className="text-button" type="button" disabled={busy} onClick={() => onAction(tag.id, 'rejected')}>否决</button>}
            {tag.status !== 'candidate' && <button className="text-button" type="button" disabled={busy} onClick={() => onAction(tag.id, 'candidate')}>恢复为候选</button>}
            <button className="text-button" type="button" disabled={busy} onClick={() => { setDraft(tag.text); setEditing(true); }}>改文字</button>
          </>
        )}
      </div>
      {tag.evidence.length > 0 && (
        <details className="tag-evidence">
          <summary>证据 {tag.evidence.length} 条</summary>
          <ul>
            {tag.evidence.map((item) => (
              <li key={item.messageId}>
                <span className="mono muted">{formatTime(item.time)}</span> {item.quote} <span className="mono muted">#{item.messageId}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function TagAddForm({ label, busy, onSubmit }: {
  label: string;
  busy: boolean;
  onSubmit: (text: string) => void;
}) {
  const [text, setText] = useState('');
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = text.trim();
    if (!value) return;
    onSubmit(value);
    setText('');
  }
  return (
    <form className="tag-add-form" onSubmit={submit}>
      <input
        value={text}
        maxLength={16}
        placeholder="2–16 字，例如：爱聊游戏"
        aria-label={label}
        onChange={(event) => setText(event.currentTarget.value)}
      />
      <button className="button button-secondary" type="submit" disabled={busy || text.trim().length === 0}>新增</button>
    </form>
  );
}

function TagSection({ tags, busy, onAction, onRename }: {
  tags: TagView[];
  busy: boolean;
  onAction: (id: number, status: TagStatus) => void;
  onRename: (id: number, text: string) => void;
}) {
  const active = tags.filter((tag) => tag.status !== 'rejected');
  const rejected = tags.filter((tag) => tag.status === 'rejected');
  return (
    <div className="tag-list">
      {active.length === 0 && <p className="muted">还没有标签。</p>}
      {active.map((tag) => (
        <TagRow key={tag.id} tag={tag} busy={busy} onAction={onAction} onRename={onRename} />
      ))}
      {rejected.length > 0 && (
        <details className="tag-collapsed">
          <summary>已否决的标签 {rejected.length} 条</summary>
          <div className="tag-list">
            {rejected.map((tag) => (
              <TagRow key={tag.id} tag={tag} busy={busy} onAction={onAction} onRename={onRename} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

export function ImpressionsPage() {
  const [groups, setGroups] = useState<SessionView[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [view, setView] = useState<ImpressionsView>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void apiRequest<SessionView[]>('/api/sessions').then((rows) => {
      const groupRows = rows.filter((row) => row.kind === 'group');
      setGroups(groupRows);
      setSelectedId((current) => current || groupRows[0]?.sessionId || '');
    }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : '读取会话失败'));
  }, []);

  const load = useCallback(async (sessionId: string) => {
    try {
      setView(await apiRequest<ImpressionsView>(`/api/impressions/${sessionId}`));
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '读取印象失败');
    }
  }, []);

  useEffect(() => {
    if (selectedId) void load(selectedId);
    else setView(undefined);
  }, [selectedId, load]);

  async function runAction(id: number, body: { text?: string; status?: TagStatus }) {
    if (!selectedId || busy) return;
    setBusy(true);
    try {
      await patch(`/api/tags/${id}`, body);
      await load(selectedId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }

  async function addTag(userId: number | null, text: string) {
    if (!selectedId || busy) return;
    setBusy(true);
    try {
      await post('/api/tags', { sessionId: selectedId, userId, text });
      await load(selectedId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '新增失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>印象</h1>
        <p className="page-description">从群聊里慢慢攒出来的标签；确认后的标签会随回复提示词一起生效。</p>
      </header>
      {error && <div className="notice notice-warn" role="alert">{error}</div>}
      <div className="impressions-toolbar">
        <label>
          <span className="field-label">选择群</span>
          <select value={selectedId} onChange={(event) => setSelectedId(event.currentTarget.value)}>
            {groups.length === 0 && <option value="">暂无群聊</option>}
            {groups.map((group) => <option value={group.sessionId} key={group.sessionId}>{group.name} · {group.sessionId}</option>)}
          </select>
        </label>
      </div>

      {!view && <div className="empty-state">选择一个群，查看它攒下的标签。</div>}
      {view && (
        <>
          <section className="panel-card tag-section">
            <div className="section-heading">
              <div><h2>群标签</h2></div>
              <span className="muted">{view.groupTags.length} 条</span>
            </div>
            <TagSection
              tags={view.groupTags}
              busy={busy}
              onAction={(id, status) => void runAction(id, { status })}
              onRename={(id, text) => void runAction(id, { text })}
            />
            <TagAddForm label="新增群标签" busy={busy} onSubmit={(text) => void addTag(null, text)} />
          </section>

          <section className="panel-card tag-section">
            <div className="section-heading">
              <div><h2>群友</h2></div>
              <span className="muted">{view.members.length} 人</span>
            </div>
            {view.members.length === 0 && <p className="muted">还没有群友标签；群里聊得多一些就会出现。</p>}
            <div className="member-grid">
              {view.members.map((member) => (
                <article className="member-card" key={member.userId}>
                  <div className="member-head">
                    <strong>{member.name}</strong>
                    <span className="mono muted">QQ {member.userId}</span>
                  </div>
                  <TagSection
                    tags={member.tags}
                    busy={busy}
                    onAction={(id, status) => void runAction(id, { status })}
                    onRename={(id, text) => void runAction(id, { text })}
                  />
                  <TagAddForm label={`给${member.name}新增标签`} busy={busy} onSubmit={(text) => void addTag(member.userId, text)} />
                </article>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
