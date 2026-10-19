import { useEffect, useState, type FormEvent } from 'react';
import { apiRequest, patch, type PrivacyFactLevel, type PrivacyFactView, type PrivacyFactsView, type SessionView } from '../api.ts';
import { redactSensitiveText } from '../sensitive-text.ts';

type PrivateFriend = { session: SessionView; account: number; userId: number };
type FactPatch = { text?: string; level?: PrivacyFactLevel; auto?: boolean };
type FactAction = (id: number, body: FactPatch) => Promise<boolean>;

function privateFriend(session: SessionView): PrivateFriend | undefined {
  if (session.kind !== 'private') return undefined;
  const [accountText, kind, userIdText, ...extra] = session.sessionId.split(':');
  const account = Number(accountText);
  const userId = Number(userIdText);
  if (kind !== 'private' || extra.length > 0
    || !Number.isSafeInteger(account) || account <= 0
    || !Number.isSafeInteger(userId) || userId <= 0) return undefined;
  return { session, account, userId };
}

function formatTime(value: number): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

function dateTime(value: number): string | undefined {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function FactLevel({ level }: { level: PrivacyFactLevel }) {
  if (level === 'L0') {
    return <span className="privacy-level privacy-level-l0">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        <rect x="3" y="7" width="10" height="7" rx="1.5" />
        <path d="M5 7V5a3 3 0 0 1 6 0v2" />
      </svg>
      仅私聊
    </span>;
  }
  return <span className={`privacy-level privacy-level-${level.toLowerCase()}`}>
    {level === 'L1' ? '提过一次' : '可聊'}
  </span>;
}

function FactCard({ fact, busy, onAction, onDelete }: {
  fact: PrivacyFactView;
  busy: boolean;
  onAction: FactAction;
  onDelete: (id: number) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(fact.text);
  const [savedText, setSavedText] = useState(fact.text);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (draft === savedText && savedText !== fact.text) {
      setDraft(fact.text);
      setSavedText(fact.text);
    }
  }, [draft, fact.text, savedText]);

  async function saveText(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (draft === fact.text || busy) return;
    if (await onAction(fact.id, { text: draft })) setSavedText(draft);
  }

  return (
    <article className="privacy-fact panel-card">
      <div className="privacy-fact-heading">
        <FactLevel level={fact.level} />
        <span className="muted">提及 {fact.mentions} 次</span>
        {fact.levelSource === 'manual' && <span className="status-pill">手动</span>}
      </div>
      {fact.textRedacted && <p className="privacy-redaction-note">敏感片段已遮蔽；保存编辑会以当前显示的遮蔽文本替换原片段。</p>}
      <div className="privacy-fact-keywords">
        <span className="muted">匹配词</span>
        {fact.keywords.map((keyword, index) => <span className="privacy-keyword" key={`${keyword}:${index}`}>{redactSensitiveText(keyword)}</span>)}
        <span className="muted">改写文本不会改变匹配词。</span>
      </div>
      <form className="privacy-fact-text-form" onSubmit={(event) => void saveText(event)}>
        <label>
          <span className="visually-hidden">私聊事实文本</span>
          <input
            type="text"
            minLength={4}
            maxLength={80}
            value={draft}
            disabled={busy}
            onChange={(event) => setDraft(event.currentTarget.value)}
          />
        </label>
        <button className="button button-secondary" type="submit" disabled={busy || draft === fact.text || Array.from(draft).length < 4 || Array.from(draft).length > 40}>
          保存文字
        </button>
      </form>
      <div className="privacy-fact-controls">
        <label>
          <span className="visually-hidden">手动设置隐私等级</span>
          <select
            aria-label="手动设置隐私等级"
            value={fact.level}
            disabled={busy}
            onChange={(event) => void onAction(fact.id, { level: event.currentTarget.value as PrivacyFactLevel })}
          >
            <option value="L0">L0 · 仅私聊</option>
            <option value="L1">L1 · 提过一次</option>
            <option value="L2">L2 · 可聊</option>
          </select>
        </label>
        {fact.levelSource === 'manual' && <button className="text-button" type="button" disabled={busy} onClick={() => void onAction(fact.id, { auto: true })}>恢复自动</button>}
        {!confirmDelete
          ? <button className="button button-warn" type="button" disabled={busy} onClick={() => setConfirmDelete(true)}>删除</button>
          : <>
            <span className="muted" role="status">删除后不再用于回复。</span>
            <button className="button button-warn" type="button" disabled={busy} onClick={() => void onDelete(fact.id)}>确认删除</button>
            <button className="button button-secondary" type="button" disabled={busy} onClick={() => setConfirmDelete(false)}>取消</button>
          </>}
      </div>
      <details className="privacy-fact-evidence">
        <summary>来源证据（{fact.evidence.length}）</summary>
        {fact.evidence.length === 0
          ? <p className="muted">没有可展示的来源证据。</p>
          : <ul>{fact.evidence.map((item, index) => (
            <li key={`${item.messageId}:${index}`}>
              <time className="mono muted" dateTime={dateTime(item.time)}>{formatTime(item.time)}</time>
              <blockquote>{redactSensitiveText(item.quote)}</blockquote>
            </li>
          ))}</ul>}
      </details>
    </article>
  );
}

export function PrivateFactsPanel({ sessions, loadingFriends }: { sessions: SessionView[]; loadingFriends: boolean }) {
  const [selectedId, setSelectedId] = useState('');
  const [facts, setFacts] = useState<PrivacyFactView[]>([]);
  const [displayName, setDisplayName] = useState('');
  const [loadingFacts, setLoadingFacts] = useState(false);
  const [busyId, setBusyId] = useState<number>();
  const [error, setError] = useState('');
  const friends = sessions.map(privateFriend).filter((friend): friend is PrivateFriend => friend !== undefined);
  const selected = friends.find((friend) => friend.session.sessionId === selectedId);

  useEffect(() => {
    setSelectedId((current) => friends.some((friend) => friend.session.sessionId === current)
        ? current
        : friends[0]?.session.sessionId ?? '');
  }, [sessions]);

  useEffect(() => {
    if (!selected) {
      setFacts([]);
      setDisplayName('');
      setLoadingFacts(false);
      return;
    }
    let active = true;
    const query = new URLSearchParams({ account: String(selected.account) });
    setLoadingFacts(true);
    setFacts([]);
    setError('');
    setDisplayName(redactSensitiveText(selected.session.name));
    void apiRequest<PrivacyFactsView>(`/api/privacy/${selected.userId}?${query}`).then((result) => {
      if (!active) return;
      setFacts(result.facts);
      setDisplayName(result.name);
      setError('');
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : '读取私聊事实失败');
    }).finally(() => { if (active) setLoadingFacts(false); });
    return () => { active = false; };
  }, [selected?.account, selected?.session.sessionId, selected?.userId]);

  async function updateFact(id: number, body: FactPatch): Promise<boolean> {
    if (!selected || busyId !== undefined) return false;
    setBusyId(id);
    try {
      const query = new URLSearchParams({ account: String(selected.account) });
      const result = await patch<{ fact: PrivacyFactView }>(`/api/privacy/facts/${id}?${query}`, body);
      setFacts((current) => current.map((fact) => fact.id === id ? result.fact : fact));
      setError('');
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '更新私聊事实失败');
      return false;
    } finally {
      setBusyId(undefined);
    }
  }

  async function deleteFact(id: number): Promise<boolean> {
    if (!selected || busyId !== undefined) return false;
    setBusyId(id);
    try {
      const query = new URLSearchParams({ account: String(selected.account) });
      await apiRequest<{ id: number; status: 'deleted' }>(`/api/privacy/facts/${id}?${query}`, { method: 'DELETE' });
      setFacts((current) => current.filter((fact) => fact.id !== id));
      setError('');
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '删除私聊事实失败');
      return false;
    } finally {
      setBusyId(undefined);
    }
  }

  return (
    <section className="privacy-facts-panel" aria-label="私聊记忆">
      <p className="privacy-facts-notice">这些内容只有你能看到；眷属在群里不会主动提起 L0。</p>
      {error && <div className="notice notice-warn" role="alert">{error}</div>}
      <div className="privacy-facts-layout">
        <aside className="privacy-friends panel-card" aria-label="好友列表">
          <div className="section-heading"><h2>好友</h2><span className="muted">{friends.length}</span></div>
          {loadingFriends && <p className="muted">正在读取好友…</p>}
          {!loadingFriends && friends.length === 0 && <p className="muted">当前没有可管理的好友会话。</p>}
          <div className="privacy-friend-list">
            {friends.map((friend) => (
              <button
                className={`privacy-friend ${selectedId === friend.session.sessionId ? 'is-selected' : ''}`}
                type="button"
                aria-pressed={selectedId === friend.session.sessionId}
                key={friend.session.sessionId}
                onClick={() => setSelectedId(friend.session.sessionId)}
              >
                <span>{redactSensitiveText(friend.session.name)}</span>
                <span className="mono muted">{friend.userId} · 账号 {friend.account}</span>
              </button>
            ))}
          </div>
        </aside>
        <div className="privacy-fact-list">
          <div className="section-heading">
            <div><h2>{displayName || '选择好友'}</h2>{selected && <p className="mono muted">{selected.userId}</p>}</div>
            {selected && <span className="muted">仅显示有效条目</span>}
          </div>
          {loadingFacts && <p className="empty-state">正在读取私聊事实…</p>}
          {!loadingFacts && selected && facts.length === 0 && <p className="empty-state">还没有保存的私聊事实。</p>}
          {!loadingFacts && facts.map((fact) => (
            <FactCard key={fact.id} fact={fact} busy={busyId !== undefined} onAction={updateFact} onDelete={deleteFact} />
          ))}
        </div>
      </div>
    </section>
  );
}
