import { useEffect, useState } from 'react';
import { apiRequest, patch } from '../api.ts';
import { memoryForAccount } from './persona-memory-state.ts';
import './PersonaMemoryPanel.css';

interface PersonaMemoryAccount {
  account: number;
  name: string;
}

interface PersonaMemoView {
  id: number;
  senderName: string;
  text: string;
  createdAt: number;
  processedCycleKey: string | null;
}

interface PersonaDiaryView {
  id: number;
  account: number;
  cycleKey: string;
  text: string;
  visibleToAni: boolean;
  sourceCount: number;
  createdAt: number;
}

interface PersonaMemoryView {
  account: number;
  memos: PersonaMemoView[];
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
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void apiRequest<PersonaMemoryAccount[]>('/api/persona-memory/accounts').then((rows) => {
      if (!active) return;
      setAccounts(rows);
      setAccount((current) => rows.some((row) => row.account === current) ? current : rows[0]?.account);
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : '读取账号失败');
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

  const selectedAccount = accounts.find((candidate) => candidate.account === account);
  const visibleMemory = memoryForAccount(memory, account);
  return (
    <section className="persona-memory-panel" aria-label="近期记忆">
      <header className="persona-memory-heading">
        <div>
          <h2>近期记忆</h2>
          <p className="muted">白天只暂存 memo；睡眠整理后形成日记，并按账号隔离。</p>
        </div>
        <label className="persona-memory-account">
          <span>账号</span>
          <select
            value={account ?? ''}
            disabled={accountsLoading || accounts.length === 0}
            onChange={(event) => setAccount(Number(event.currentTarget.value))}
          >
            {accounts.length === 0 && <option value="">暂无可用账号</option>}
            {accounts.map((entry) => <option value={entry.account} key={entry.account}>{entry.name} · {entry.account}</option>)}
          </select>
        </label>
      </header>
      {error && <p className="notice notice-warn" role="alert">{error}</p>}
      {loading && <p className="muted" role="status">正在读取近期记忆…</p>}
      {!loading && !accountsLoading && accounts.length === 0 && <p className="empty-state">当前没有已连接的账号。</p>}
      {!loading && selectedAccount && visibleMemory && <>
        <section className="persona-memory-section" aria-labelledby="persona-memos-title">
          <div className="persona-memory-section-heading">
            <h3 id="persona-memos-title">Memo</h3>
            <span className="muted">最近 {visibleMemory.memos.length} 条</span>
          </div>
          {visibleMemory.memos.length === 0 ? <p className="muted">还没有暂存的 memo。</p> : (
            <ul className="persona-memory-list">
              {visibleMemory.memos.map((memo) => (
                <li className="persona-memory-entry" key={memo.id}>
                  <div className="persona-memory-meta">
                    <strong>{memo.senderName}</strong>
                    <time dateTime={new Date(memo.createdAt).toISOString()}>{formatTime(memo.createdAt)}</time>
                    <span>{memo.processedCycleKey ? `已整理 · ${memo.processedCycleKey}` : '待夜间整理'}</span>
                  </div>
                  <p>{memo.text}</p>
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
                        <option value="private">仅人格自知</option>
                        <option value="visible">对 AnI 可见</option>
                      </select>
                    </label>
                  </div>
                  <p className="persona-memory-diary-text">{diary.text}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </>}
    </section>
  );
}
