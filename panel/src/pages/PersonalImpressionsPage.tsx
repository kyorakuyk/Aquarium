import { useEffect, useMemo, useState } from 'react';
import { apiRequest, type PanelStatus, type ViewImpression } from '../api.ts';
import { factPromotionUnavailableReason } from '../../../src/core/impressions/tag-model.ts';
import { tagOriginLabel } from '../impressions-model.ts';
import { personalImpressionsErrorText, showEmptyPersonalImpressions } from '../panel-feedback.ts';

const CATEGORY_LABELS: Record<ViewImpression['category'], string> = {
  positioning: '立场',
  topic: '话题',
  atmosphere: '氛围',
  meme: '梗',
  norms: '群规',
  identity: '身份',
  personality: '性格',
  fandom: '喜好',
  speech: '说话方式',
  catchphrase: '口头禅',
  social: '社交',
  recent: '近期',
  dislike: '不喜欢',
  schedule: '作息',
  misc: '其他',
};

const STATUS_LABELS: Record<ViewImpression['status'], string> = {
  candidate: '待观察',
  confirmed: '已确认',
  rejected: '已忽略',
  superseded: '已替代',
};

interface ImpressionGroup {
  key: string;
  name: string;
  tags: ViewImpression[];
}

function groupImpressions(tags: readonly ViewImpression[]): ImpressionGroup[] {
  const groups = new Map<string, ImpressionGroup>();
  for (const tag of tags) {
    const key = tag.userId === null ? `session:${tag.sessionId}` : `member:${tag.userId}`;
    const group = groups.get(key) ?? {
      key,
      name: tag.userId === null ? `${tag.sessionLabel} · 群聊` : tag.name,
      tags: [],
    };
    group.tags.push(tag);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function displayedText(tag: ViewImpression): string {
  if (tag.certain || tag.text.endsWith('?')) return tag.text;
  return `${tag.text}?`;
}

function promotionReason(tag: ViewImpression): string | undefined {
  if (tag.status !== 'confirmed') return '仅已确认的印象可提升为知识';
  if (tag.sourceKind === null) return '来源会话无效，不能提升为知识';
  return factPromotionUnavailableReason(
    tag.category,
    tag.userId === null ? 'group' : 'member',
    tag.sourceKind,
  );
}

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
      if (active) setError(reason instanceof Error ? reason.message : '读取账号失败');
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

  const groups = useMemo(() => groupImpressions(tags), [tags]);

  async function runAction(tag: ViewImpression, action: 'confirm' | 'delete' | 'promote'): Promise<void> {
    if (selectedAccount === undefined || pendingId !== undefined) return;
    if (action === 'delete' && !window.confirm(`删除印象「${displayedText(tag)}」？`)) return;
    if (action === 'promote' && !window.confirm(`将「${tag.text}」提升为知识？`)) return;
    setPendingId(tag.id);
    setError('');
    const url = `/api/accounts/${selectedAccount}/view-impressions/${tag.id}`;
    try {
      await apiRequest(action === 'delete' ? url : `${url}/${action}`, {
        method: action === 'delete' ? 'DELETE' : 'POST',
      });
      setRefreshVersion((version) => version + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存印象操作失败');
    } finally {
      setPendingId(undefined);
    }
  }

  return (
    <div className="page personal-impressions-page">
      <header className="page-header personal-impressions-header">
        <div>
          <h1>印象</h1>
          <p className="page-description">这是人格自己的看法；带 ? 的条目尚不确定，也可能与他人不同。</p>
        </div>
        {(status?.accounts.length ?? 0) > 1 && <label className="personal-impressions-account">
          <span>人格账号</span>
          <select
            aria-label="选择人格账号"
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
      </header>
      {error && <div className="notice notice-warn" role="alert">{error}</div>}
      {loadingAccounts && <div className="empty-state" role="status">正在读取账号…</div>}
      {!loadingAccounts && !status?.accounts.length && <div className="empty-state">尚无可查看的人格账号。</div>}
      {!loadingAccounts && selectedAccount !== undefined && loadingTags && <div className="empty-state" role="status">正在读取印象…</div>}
      {selectedAccount !== undefined && showEmptyPersonalImpressions(loadingAccounts || loadingTags, error, groups.length)
        && <div className="empty-state">还没有整理出的个人印象。</div>}
      {!loadingTags && groups.length > 0 && <div className="personal-impressions-groups">
        {groups.map((group) => <section className="panel-card personal-impression-group" key={group.key}>
          <header className="personal-impression-group-heading">
            <div>
              <h2>{group.name}</h2>
              <p>{group.tags.length} 条印象</p>
            </div>
          </header>
          <div className="personal-impression-list">
            {group.tags.map((tag) => {
              const reason = promotionReason(tag);
              const pending = pendingId === tag.id;
              return <article className="personal-impression-row" key={tag.id}>
                <div className="personal-impression-copy">
                  <p className="personal-impression-text">{displayedText(tag)}</p>
                  <div className="personal-impression-meta">
                    <span>{CATEGORY_LABELS[tag.category]}</span>
                    <span>{tagOriginLabel(tag.origin)}</span>
                    <span>{STATUS_LABELS[tag.status]}</span>
                    {tag.locked && <span>已锁定</span>}
                    {tag.userId !== null && <span>{tag.sessionLabel}</span>}
                  </div>
                </div>
                <div className="personal-impression-actions">
                  {!tag.certain && (tag.status === 'candidate' || tag.status === 'confirmed') && <button
                    className="button button-secondary"
                    type="button"
                    disabled={pending}
                    onClick={() => void runAction(tag, 'confirm')}
                  >{pending ? '正在保存…' : '确认为确定'}</button>}
                  <div className="personal-impression-promotion">
                    <button
                      className="button button-secondary"
                      type="button"
                      disabled={pending || Boolean(reason)}
                      title={reason}
                      aria-describedby={reason ? `promotion-reason-${tag.id}` : undefined}
                      onClick={() => void runAction(tag, 'promote')}
                    >提升为知识</button>
                    {reason && <small id={`promotion-reason-${tag.id}`} className="personal-impression-reason">{reason}</small>}
                  </div>
                  <button
                    className="button button-warn"
                    type="button"
                    disabled={pending}
                    onClick={() => void runAction(tag, 'delete')}
                  >删除</button>
                </div>
              </article>;
            })}
          </div>
        </section>)}
      </div>}
    </div>
  );
}
