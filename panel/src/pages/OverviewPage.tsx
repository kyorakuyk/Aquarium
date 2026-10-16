import { useEffect, useState } from 'react';
import { apiRequest, post, type DecisionView, type PanelStatus, type SessionView, type UsageView } from '../api.ts';
import type { PageId } from '../components/Sidebar.tsx';
import { decisionLabel, decisionTone } from '../labels.ts';

function money(value: number): string {
  return `¥${value.toFixed(2)}`;
}

function shortTime(value: number | null): string {
  if (value === null) return '尚无发言';
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(value);
}

function fullTime(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(value);
}

function connectionLabel(status: PanelStatus['accounts'][number]['connectionStatus']): string {
  if (status === 'online') return '在线';
  if (status === 'connecting') return '连接中';
  return '等待重连';
}

export function OverviewPage({ onNavigate }: { onNavigate: (page: PageId) => void }) {
  const [status, setStatus] = useState<PanelStatus>();
  const [sessions, setSessions] = useState<SessionView[]>([]);
  const [decisions, setDecisions] = useState<DecisionView[]>([]);
  const [usage, setUsage] = useState<UsageView>();
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    void Promise.all([
      apiRequest<PanelStatus>('/api/status'),
      apiRequest<SessionView[]>('/api/sessions'),
      apiRequest<DecisionView[]>('/api/decisions?limit=5'),
      apiRequest<UsageView>('/api/usage/today'),
    ]).then(([nextStatus, nextSessions, nextDecisions, nextUsage]) => {
      setStatus(nextStatus);
      setSessions(nextSessions);
      setDecisions(nextDecisions);
      setUsage(nextUsage);
      setMuted(nextStatus.allMuted);
      setError('');
    }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : '读取控制台数据失败'));
  }, []);

  async function toggleMute() {
    try {
      await post(muted ? '/api/unmute-all' : '/api/mute-all');
      setMuted(!muted);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '操作失败');
    }
  }

  if (error && !status) return <div className="page"><div className="notice notice-warn" role="alert">{error}</div></div>;
  if (!status) return <div className="page"><p className="muted">正在读取本机状态…</p></div>;

  const progress = status.budgetState.dailyLimitCny > 0
    ? Math.min(100, (status.todayCostCny / status.budgetState.dailyLimitCny) * 100)
    : 0;
  const cacheRatio = usage && usage.inputTokens > 0
    ? Math.round((usage.cachedTokens / usage.inputTokens) * 100)
    : 0;
  const accountCount = status.accounts.length;
  const onlineAccountCount = status.accounts.filter((item) => item.connectionStatus === 'online').length;
  const tankDescription = accountCount === 0
    ? '还没有眷属。'
    : `${accountCount} 位眷属，${onlineAccountCount} 位在线。`;

  return (
    <div className="page">
      <header className="page-header page-header-actions">
        <div>
          <h1>总览</h1>
          <p className="page-description">{tankDescription}</p>
        </div>
        <div className="header-actions">
          <button className="button button-secondary" type="button" onClick={() => onNavigate('sandbox')}>去试聊</button>
          <button className={`button ${muted ? 'button-secondary' : 'button-warn'}`} type="button" onClick={() => void toggleMute()}>
            {muted ? '恢复发言' : '全部闭嘴'}
          </button>
        </div>
      </header>
      {error && <div className="notice notice-warn" role="alert">{error}</div>}
      {status.accounts.some((account) => account.degraded) && (
        <div className="notice notice-warn" role="status">QQ 联系人数据暂未刷新；当前显示上次缓存或可能不完整。</div>
      )}

      <section className="section-block">
        <div className="section-heading"><h2>眷属</h2><span className="muted">{status.accounts.length} 个账号</span></div>
        <div className="tank-grid">
          {status.accounts.map((account) => (
            <article className="tank-card" key={account.account}>
              <div className="tank-card-top">
                <span className="avatar-initial">{Array.from(account.name)[0] ?? '水'}</span>
                <span className={`status-pill status-${account.connectionStatus}`}>{connectionLabel(account.connectionStatus)}</span>
              </div>
              <h3>{account.name}</h3>
              <p className="mono muted">QQ {account.account}</p>
              <p className="muted">人设：{account.persona}.md</p>
              <div className="tank-card-stats">
                <span>今日回复 <strong>{account.todayReplyCount}</strong></span>
                <span>启用会话 <strong>{sessions.filter((item) => item.enabled && item.sessionId.startsWith(`${account.account}:`)).length}</strong></span>
              </div>
              <div className="last-reply">
                <span className="muted">上次发言 · {shortTime(account.lastReplyAt)}</span>
                {account.lastReplyText && <p>{account.lastReplyText}</p>}
              </div>
            </article>
          ))}
          <div className="tank-card tank-card-placeholder" aria-label="多账号功能即将开放">
            <span className="placeholder-mark">＋</span>
            <strong>添加新眷属</strong>
            <span className="m2-tag">M3 多账号</span>
          </div>
        </div>
      </section>

      <section className="stats-grid section-block">
        <article className="panel-card stat-card">
          <div className="card-title">今日花费</div>
          <strong className="stat-number mono">{money(status.todayCostCny)}</strong>
          <div className="progress-track" role="progressbar" aria-label="今日预算使用比例" aria-valuenow={Math.round(progress)} aria-valuemin={0} aria-valuemax={100}>
            <span style={{ width: `${progress}%` }} />
          </div>
          <div className="stat-foot"><span>预算 {money(status.budgetState.dailyLimitCny)}</span><span>{progress.toFixed(0)}%</span></div>
          <span className={`budget-label budget-${status.budgetState.state}`}>
            {status.budgetState.state === 'ok' ? '预算正常' : status.budgetState.state === 'warn' ? '接近预算提醒线' : '已达到每日预算'}
          </span>
        </article>
        <article className="panel-card stat-card">
          <div className="card-title">模型调用</div>
          <strong className="stat-number mono">{usage?.requestCount ?? 0}<small> 次</small></strong>
          <div className="metric-row"><span>缓存命中</span><strong className="mono">{cacheRatio}%</strong></div>
          <div className="metric-row"><span>平均耗时</span><strong className="mono">{Math.round(usage?.averageLatencyMs ?? 0)} ms</strong></div>
        </article>
        <article className="panel-card stat-card chain-card">
          <div className="card-title">运行链路</div>
          <div className="chain-step"><span className={`chain-dot ${onlineAccountCount > 0 ? 'dot-online' : ''}`} /><span>QQ（小号）</span><strong>{onlineAccountCount > 0 ? '在线' : '未连接'}</strong></div>
          <div className="chain-step"><span className={`chain-dot ${status.accounts.some((item) => item.snowlumaConfigured) ? 'dot-online' : ''}`} /><span>SnowLuma</span><strong>{status.accounts.some((item) => item.snowlumaConfigured) ? '已配置' : '未配置'}</strong></div>
          <div className="chain-step"><span className="chain-dot dot-online" /><span>Aquarium</span><strong className="mono">PID {status.runtime.pid} · :{status.runtime.port}</strong></div>
          <p className="stat-foot">运行 {Math.floor(status.runtime.uptimeSeconds / 60)} 分钟</p>
        </article>
      </section>

      <section className="section-block panel-card table-card">
        <div className="section-heading">
          <div><h2>最近的决定</h2><p className="muted">每一次回复与跳过都留有记录。</p></div>
          <button className="text-button" type="button" onClick={() => onNavigate('sandbox')}>查看全部决策追踪 →</button>
        </div>
        <div className="table-scroll">
          <table>
            <thead><tr><th>时间</th><th>会话</th><th>消息</th><th>结果</th><th>费用</th></tr></thead>
            <tbody>
              {decisions.map((decision) => (
                <tr key={decision.id}>
                  <td className="mono">{fullTime(decision.time)}</td>
                  <td>{decision.sessionName}</td>
                  <td>{decision.messageText ?? '—'}</td>
                  <td><span className={`result-pill result-${decisionTone(decision.reason)}`}>{decisionLabel(decision.reason)}</span></td>
                  <td className="mono muted">{decision.costCny === null ? '—' : `¥${decision.costCny.toFixed(4)}`}</td>
                </tr>
              ))}
              {decisions.length === 0 && <tr><td className="empty-cell" colSpan={5}>暂时还没有决定记录。</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
