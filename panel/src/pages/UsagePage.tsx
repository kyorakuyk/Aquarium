import { Fragment, useEffect, useState } from 'react';
import { apiRequest, type PanelStatus, type UsageRange, type UsageRangeView, type UsageRowView } from '../api.ts';
import { redactSensitiveText } from '../sensitive-text.ts';
import { usageAccountLabels, usageCostLabel } from '../usage-view.ts';

const RANGE_OPTIONS: Array<{ value: UsageRange; label: string }> = [
  { value: 'today', label: '今日' },
  { value: '7d', label: '7 天' },
  { value: '30d', label: '30 天' },
];

const SLOT_LABELS: Record<string, string> = {
  reply: '回复',
  judge: '主动判断',
  vision: '看图',
  appraise: '情绪评估',
  extract: '印象提取',
};

function number(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value);
}

function ratio(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

function latency(value: number): string {
  return value >= 1_000 ? `${(value / 1_000).toFixed(1)} s` : `${Math.round(value)} ms`;
}

function rowKey(row: UsageRowView): string {
  return JSON.stringify([row.provider, row.account]);
}

function Sparkline({ values }: { values: number[] }) {
  const maximum = Math.max(1, ...values);
  const points = values.map((value, index) => {
    const x = index * 120 / Math.max(values.length - 1, 1);
    const y = 29 - value / maximum * 24;
    return `${x},${y}`;
  }).join(' ');
  return (
    <svg className="usage-sparkline" viewBox="0 0 120 32" role="img" aria-label={`最近 7 天调用次数：${values.join('、')}`}>
      <polyline points={points} fill="none" stroke="var(--accent)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function UsagePage() {
  const [range, setRange] = useState<UsageRange>('7d');
  const [report, setReport] = useState<UsageRangeView>();
  const [accounts, setAccounts] = useState<PanelStatus['accounts']>([]);
  const [expandedRow, setExpandedRow] = useState<string>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let active = true;
    void apiRequest<PanelStatus>('/api/status').then((status) => {
      if (active) setAccounts(status.accounts);
    }).catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    setReport(undefined);
    void apiRequest<UsageRangeView>(`/api/usage?range=${range}`)
      .then((value) => { if (active) setReport(value); })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : '读取用量失败');
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [range]);

  const budget = report?.totals.budgetToday;
  const budgetPercent = budget && budget.limit > 0 ? Math.min(100, budget.used / budget.limit * 100) : 0;

  return (
    <div className="page usage-page">
      <header className="page-header">
        <div className="page-header-actions usage-page-header">
          <div>
            <h1>用量</h1>
            <p className="page-description">按本机自然日汇总接入与眷属调用。</p>
          </div>
          <div className="page-tabs usage-range-tabs" role="tablist" aria-label="用量时间范围">
            {RANGE_OPTIONS.map((option) => <button
              className={range === option.value ? 'is-active' : ''}
              type="button"
              role="tab"
              aria-selected={range === option.value}
              key={option.value}
              onClick={() => { setExpandedRow(undefined); setRange(option.value); }}
            >{option.label}</button>)}
          </div>
        </div>
      </header>
      {error && <div className="notice notice-warn" role="alert">{error}</div>}
      {!report && loading && <p className="muted">正在读取用量…</p>}
      {report && <>
        <section className="panel-card usage-summary">
          <div className="usage-metric"><span>花费</span><strong className="mono">¥{report.totals.costCny.toFixed(2)}</strong></div>
          <div className="usage-metric"><span>调用</span><strong className="mono">{number(report.totals.calls)}</strong></div>
          <div className="usage-metric"><span>缓存命中</span><strong className="mono">{ratio(report.totals.cacheHitRatio)}</strong></div>
          <div className="usage-budget">
            <div className="usage-budget-heading"><span>今日预算</span><span className="mono">¥{budget?.used.toFixed(2) ?? '0.00'} / ¥{budget?.limit.toFixed(2) ?? '0.00'}</span></div>
            <div className="progress-track" role="progressbar" aria-label="今日预算使用比例" aria-valuemin={0} aria-valuemax={100} aria-valuenow={budgetPercent}>
              <span style={{ width: `${budgetPercent}%` }} />
            </div>
          </div>
        </section>

        <section className="panel-card usage-table-card">
          <div className="section-heading"><h2>接入明细</h2>{loading && <span className="muted">正在更新…</span>}</div>
          {report.rows.length === 0
            ? <p className="empty-state">这个时间范围内还没有用量记录。</p>
            : <div className="table-scroll">
              <table className="usage-table">
                <thead><tr>
                  <th>接入 · 眷属</th><th>调用</th><th>花费</th><th>平均耗时</th><th>缓存命中</th><th>7 天</th>
                </tr></thead>
                <tbody>
                  {report.rows.map((row) => {
                    const key = rowKey(row);
                    const open = expandedRow === key;
                    const accountLabels = usageAccountLabels(row.account, accounts);
                    return <Fragment key={key}>
                      <tr className="usage-data-row">
                        <td><button className="usage-row-toggle" type="button" aria-expanded={open} onClick={() => setExpandedRow(open ? undefined : key)}>
                          <span className="usage-row-chevron" aria-hidden="true">{open ? '⌃' : '⌄'}</span>
                          <span className="usage-row-label"><strong>{redactSensitiveText(row.provider)} · {accountLabels.primary}</strong><small>{accountLabels.secondary}</small></span>
                        </button></td>
                        <td className="mono">{number(row.calls)}</td>
                        <td className="mono">{usageCostLabel(row.provider, row.costCny)}</td>
                        <td className="mono">{latency(row.avgLatencyMs)}</td>
                        <td className="mono">{ratio(row.cacheHitRatio)}</td>
                        <td><Sparkline values={row.daily} /></td>
                      </tr>
                      {open && <tr className="usage-detail-row"><td colSpan={6}>
                        <div className="usage-slot-list">
                          {row.bySlot.map((slot) => <div className="usage-slot-row" key={slot.slot}>
                            <strong>{SLOT_LABELS[slot.slot] ?? redactSensitiveText(slot.slot)}</strong>
                            <span className="mono">{number(slot.calls)} 次</span>
                            <span className="mono">{usageCostLabel(row.provider, slot.costCny)}</span>
                            <span className="mono">平均 {latency(slot.avgLatencyMs)}</span>
                          </div>)}
                        </div>
                      </td></tr>}
                    </Fragment>;
                  })}
                </tbody>
              </table>
            </div>}
        </section>
      </>}
    </div>
  );
}
