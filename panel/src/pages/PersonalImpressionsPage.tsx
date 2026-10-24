import { useEffect, useState } from 'react';
import { apiRequest, type PanelStatus, type ViewImpression } from '../api.ts';
import { PersonalImpressionsWorkspace } from '../components/PersonalImpressionsWorkspace.tsx';
import type { PersonalImpressionAction } from '../components/PersonalImpressionChip.tsx';
import { personalImpressionsErrorText, showEmptyPersonalImpressions } from '../panel-feedback.ts';

export function PersonalImpressionsPage() {
  const [status, setStatus] = useState<PanelStatus>();
  const [selectedAccount, setSelectedAccount] = useState<number>();
  const [tags, setTags] = useState<ViewImpression[]>([]);
  const [loadingAccounts, setLoadingAccounts] = useState(true);
  const [loadingTags, setLoadingTags] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [pendingId, setPendingId] = useState<number>();
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    void apiRequest<PanelStatus>('/api/status').then((result) => {
      if (!active) return;
      setStatus(result);
      setSelectedAccount((current) => current ?? result.accounts[0]?.account);
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : '读取眷属失败');
    }).finally(() => {
      if (active) setLoadingAccounts(false);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (selectedAccount === undefined) {
      setTags([]);
      setLoadingTags(false);
      return;
    }
    let active = true;
    setTags([]);
    setLoadingTags(true);
    setError('');
    void apiRequest<{ account: number; tags: ViewImpression[] }>(
      `/api/accounts/${selectedAccount}/view-impressions`,
    ).then((result) => {
      if (active) setTags(result.tags);
    }).catch((reason: unknown) => {
      if (active) setError(personalImpressionsErrorText(reason instanceof Error ? reason.message : '读取印象失败'));
    }).finally(() => {
      if (active) setLoadingTags(false);
    });
    return () => { active = false; };
  }, [selectedAccount, refreshVersion]);

  async function runAction(tag: ViewImpression, action: PersonalImpressionAction): Promise<boolean> {
    if (selectedAccount === undefined || pendingId !== undefined) return false;
    if (action === 'delete' && !window.confirm(`删除印象「${tag.text}」？`)) return false;
    if (action === 'promote' && !window.confirm(`将「${tag.text}」提升为知识？`)) return false;
    setPendingId(tag.id);
    setError('');
    const url = `/api/accounts/${selectedAccount}/view-impressions/${tag.id}`;
    try {
      await apiRequest(action === 'delete' ? url : `${url}/${action}`, {
        method: action === 'delete' ? 'DELETE' : 'POST',
      });
      setRefreshVersion((version) => version + 1);
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存印象操作失败');
      return false;
    } finally {
      setPendingId(undefined);
    }
  }

  return (
    <div className="page personal-impressions-page">
      <header className="page-header personal-impressions-header">
        <div className="personal-impressions-title">
          <h1>印象</h1>
          <p className="page-description">这是眷属自己的看法；带 ? 的条目尚不确定，也可能与他人不同。</p>
        </div>
        <div className="personal-impressions-tools">
          <ul className="personal-impressions-legend" aria-label="印象状态说明">
            <li><span className="personal-impressions-legend-chip is-certain" />确定</li>
            <li><span className="personal-impressions-legend-chip is-uncertain" />不确定 ?</li>
            <li><span className="personal-impressions-legend-chip is-candidate" />待观察 ?</li>
          </ul>
          {(status?.accounts.length ?? 0) > 1 && <label className="personal-impressions-account">
            <span>眷属</span>
            <select
              aria-label="选择眷属"
              value={selectedAccount ?? ''}
              onChange={(event) => {
                setTags([]);
                setLoadingTags(true);
                setError('');
                setSelectedAccount(Number(event.currentTarget.value));
              }}
            >
              {status?.accounts.map((account) => <option value={account.account} key={account.account}>
                {account.name} · {account.persona}
              </option>)}
            </select>
          </label>}
        </div>
      </header>
      {error && <div className="notice notice-warn" role="alert">{error}</div>}
      {loadingAccounts && <div className="empty-state" role="status">正在读取眷属…</div>}
      {!loadingAccounts && !status?.accounts.length && <div className="empty-state">尚无可查看的眷属。</div>}
      {!loadingAccounts && selectedAccount !== undefined && loadingTags && <div className="empty-state" role="status">正在读取印象…</div>}
      {selectedAccount !== undefined && showEmptyPersonalImpressions(loadingAccounts || loadingTags, error, tags.length)
        && <div className="empty-state">还没有整理出的个人印象。</div>}
      {!loadingTags && tags.length > 0 && <PersonalImpressionsWorkspace
        key={selectedAccount}
        tags={tags}
        pendingId={pendingId}
        onAction={runAction}
      />}
    </div>
  );
}
