import { useEffect, useState } from 'react';
import { apiRequest, patch } from '../api.ts';
import { memoryForAccount } from './persona-memory-state.ts';
import './PersonaMemoryPanel.css';

interface PersonaMemoryAccount {
  account: number;
  name: string;
}

interface PersonaDiaryView {
  id: number;
  account: number;
  cycleKey: string;
  text: string;
  sourceMemoIds: number[];
  visibleToAni: boolean;
  sourceCount: number;
  createdAt: number;
}

interface PersonaEventMemoView {
  id: number;
  eventId: number | null;
  title: string;
  summary: string;
  participantIds: number[];
  startMessageId: string;
  endMessageId: string;
  level: 'L0' | 'L1' | 'L2';
  createdAt: number;
  diaryCycle: string | null;
}

interface PersonaMemoryView {
  account: number;
  pendingMessageCount: number;
  openSegmentCount: number;
  cacheSessions: Array<{ sessionId: string; label: string; pendingMessageCount: number }>;
  memos: PersonaEventMemoView[];
  diaries: PersonaDiaryView[];
}

function formatTime(time: number): string {
  return new Date(time).toLocaleString('zh-CN', { hour12: false });
}

export function PersonaMemoryPanel() {
  const [accounts, setAccounts] = useState<PersonaMemoryAccount[]>([]);
  const [account, setAccount] = useState<number>();
  const [memory, setMemory] = useState<PersonaMemoryView>();
  const [loading, setLoading] = useState(false);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [savingId, setSavingId] = useState<number>();
  const [cacheScope, setCacheScope] = useState('');
  const [clearingCache, setClearingCache] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let active = true;
    void apiRequest<PersonaMemoryAccount[]>('/api/persona-memory/accounts').then((rows) => {
      if (!active) return;
      setAccounts(rows);
      setAccount((current) => rows.some((row) => row.account === current) ? current : rows[0]?.account);
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : '读取眷属失败');
    }).finally(() => {
      if (active) setAccountsLoading(false);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (account === undefined) {
      setMemory(undefined);
      setLoading(false);
      return;
    }
    let active = true;
    setMemory(undefined);
    setLoading(true);
    void apiRequest<PersonaMemoryView>(`/api/persona-memory?account=${account}`).then((result) => {
      if (!active) return;
      setMemory(result);
      setError('');
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : '读取近期记忆失败');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [account, refreshVersion]);

  async function changeVisibility(diary: PersonaDiaryView, visibleToAni: boolean): Promise<void> {
    if (account === undefined || savingId !== undefined) return;
    setSavingId(diary.id);
    setError('');
    try {
      await patch(`/api/persona-memory/diaries/${diary.id}?account=${account}`, { visibleToAni });
      setRefreshVersion((current) => current + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '日记可见范围保存失败');
    } finally {
      setSavingId(undefined);
    }
  }

  async function clearCache(): Promise<void> {
    if (account === undefined || clearingCache) return;
    const selectedScope = visibleMemory?.cacheSessions.find(({ sessionId }) => sessionId === cacheScope);
    const scopeLabel = selectedScope?.label ?? '全部已整理缓存';
    if (!window.confirm(`确认清除${scopeLabel}中游标之前的原文缓存？未整理消息、memo、日记和事件簿不会被清除。`)) return;
    setClearingCache(true);
    setError('');
    setNotice('');
    try {
      const sessionQuery = cacheScope ? `&sessionId=${encodeURIComponent(cacheScope)}` : '';
      const result = await apiRequest<{ deletedMessages: number }>(
        `/api/persona-memory/cache?account=${account}${sessionQuery}`,
        { method: 'DELETE' },
      );
      setNotice(`已清除 ${result.deletedMessages} 条原文缓存。`);
      setRefreshVersion((current) => current + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '原文缓存清除失败');
    } finally {
      setClearingCache(false);
    }
  }

  const selectedAccount = accounts.find((candidate) => candidate.account === account);
  const visibleMemory = memoryForAccount(memory, account);
  return (
    <section className="persona-memory-panel" aria-label="近期记忆">
      <header className="persona-memory-heading">
        <div>
          <h2>近期记忆</h2>
          <p className="muted">白天只暂存 memo；睡眠整理后形成日记，并按眷属隔离。</p>
        </div>
        <label className="persona-memory-account">
          <span>眷属</span>
          <select
            value={account ?? ''}
            disabled={accountsLoading || accounts.length === 0}
            onChange={(event) => {
              setAccount(Number(event.currentTarget.value));
              setCacheScope('');
              setNotice('');
            }}
          >
            {accounts.length === 0 && <option value="">暂无可用眷属</option>}
            {accounts.map((entry) => <option value={entry.account} key={entry.account}>{entry.name} · {entry.account}</option>)}
          </select>
        </label>
      </header>
      {error && <p className="notice notice-warn" role="alert">{error}</p>}
      {notice && <p className="notice" role="status">{notice}</p>}
      {loading && <p className="muted" role="status">正在读取近期记忆…</p>}
      {!loading && !accountsLoading && accounts.length === 0 && <p className="empty-state">当前没有已连接的眷属。</p>}
      {!loading && selectedAccount && visibleMemory && <>
        <section className="persona-memory-section" aria-labelledby="persona-memos-title">
          <div className="persona-memory-section-heading">
            <h3 id="persona-memos-title">暂存区</h3>
          </div>
          <p className="persona-memory-staging-summary">
            暂存 <strong>{visibleMemory.pendingMessageCount}</strong> 条，
            <strong>{visibleMemory.openSegmentCount}</strong> 段进行中
          </p>
          <div className="persona-memory-cache-controls">
            <label className="persona-memory-cache-scope">
              <span>清理范围</span>
              <select value={cacheScope} onChange={(event) => setCacheScope(event.currentTarget.value)}>
                <option value="">全部已整理缓存</option>
                {visibleMemory.cacheSessions.map((session) => (
                  <option value={session.sessionId} key={session.sessionId}>{session.label}</option>
                ))}
              </select>
            </label>
            <button
              className="button button-warn"
              type="button"
              disabled={clearingCache}
              onClick={() => void clearCache()}
            >
              {clearingCache ? '清除中…' : '清除原文缓存'}
            </button>
          </div>
          <p className="persona-memory-cache-help muted">仅清理已整理且游标之前的原文；未整理内容、memo、日记和事件簿保留。</p>
          {visibleMemory.pendingMessageCount === 0 && <p className="muted">暂存区当前为空。</p>}
        </section>
        <section className="persona-memory-section" aria-labelledby="persona-event-memos-title">
          <div className="persona-memory-section-heading">
            <h3 id="persona-event-memos-title">已整理 memo</h3>
            <span className="muted">最近 {visibleMemory.memos.length} 条</span>
          </div>
          {visibleMemory.memos.length === 0 ? <p className="muted">事件整理完成后会在这里留下摘要。</p> : (
            <ul className="persona-memory-list">
              {visibleMemory.memos.map((memo) => (
                <li className="persona-memory-entry" key={memo.id}>
                  <div className="persona-memory-meta">
                    <strong>{memo.title}</strong>
                    <time dateTime={new Date(memo.createdAt).toISOString()}>{formatTime(memo.createdAt)}</time>
                    <span>{memo.level}</span>
                  </div>
                  <p>{memo.summary}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="persona-memory-section" aria-labelledby="persona-diaries-title">
          <div className="persona-memory-section-heading">
            <h3 id="persona-diaries-title">日记</h3>
            <span className="muted">最近 {visibleMemory.diaries.length} 篇</span>
          </div>
          {visibleMemory.diaries.length === 0 ? <p className="muted">睡眠整理完成后会在这里留下近期回忆。</p> : (
            <ul className="persona-memory-list">
              {visibleMemory.diaries.map((diary) => (
                <li className="persona-memory-entry" key={diary.id}>
                  <div className="persona-memory-meta">
                    <strong>{diary.cycleKey}</strong>
                    <time dateTime={new Date(diary.createdAt).toISOString()}>{formatTime(diary.createdAt)}</time>
                    <label className="persona-memory-visibility">
                      <span>可见范围</span>
                      <select
                        aria-label={`${diary.cycleKey} 日记可见范围`}
                        value={diary.visibleToAni ? 'visible' : 'private'}
                        disabled={savingId !== undefined}
                        onChange={(event) => void changeVisibility(diary, event.currentTarget.value === 'visible')}
                      >
                        <option value="private">仅眷属自知</option>
                        <option value="visible">对 AnI 可见</option>
                      </select>
                    </label>
                  </div>
                  <p className="persona-memory-diary-text">{diary.text}</p>
                  {diary.sourceMemoIds.length > 0 && (
                    <p className="persona-memory-citations muted">
                      引用 memo：{diary.sourceMemoIds.map((id) => `#${id}`).join('、')}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </>}
    </section>
  );
}
