import { useEffect, useState } from 'react';
import { apiRequest, type UsageView } from '../api.ts';

function number(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value);
}

export function UsagePage() {
  const [usage, setUsage] = useState<UsageView>();
  const [error, setError] = useState('');

  useEffect(() => {
    void apiRequest<UsageView>('/api/usage/today')
      .then(setUsage)
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : '读取用量失败'));
  }, []);

  return (
    <div className="page">
      <header className="page-header"><div className="eyebrow">AQUARIUM / USAGE</div><h1>用量</h1><p className="page-description">按本机自然日统计模型调用与费用。</p></header>
      {error && <div className="notice notice-warn" role="alert">{error}</div>}
      {!usage && !error && <p className="muted">正在读取用量…</p>}
      {usage && <>
        <section className="usage-grid">
          <article className="panel-card stat-card"><div className="card-title">模型调用</div><strong className="stat-number mono">{number(usage.requestCount)}</strong><div className="stat-foot">成功 {number(usage.successfulRequests)} · 失败 {number(usage.failedRequests)}</div></article>
          <article className="panel-card stat-card"><div className="card-title">今日费用</div><strong className="stat-number mono">¥{usage.costCny.toFixed(4)}</strong><div className="stat-foot">按配置中的模型单价估算</div></article>
          <article className="panel-card stat-card"><div className="card-title">输入与缓存</div><strong className="stat-number mono">{number(usage.inputTokens)}<small> 输入 tokens</small></strong><div className="stat-foot">缓存 {number(usage.cachedTokens)} · 输出 {number(usage.outputTokens)}</div></article>
          <article className="panel-card stat-card"><div className="card-title">平均响应时间</div><strong className="stat-number mono">{Math.round(usage.averageLatencyMs)}<small> ms</small></strong><div className="stat-foot">涵盖今天所有已记录调用</div></article>
        </section>
        <section className="panel-card usage-note"><h2>关于用量记录</h2><p>当前数据由 Aquarium 本地 SQLite 用量表汇总。试聊产生的模型调用也会计入费用；不会写入会话消息。</p><p className="muted">面板暂不展示逐模型明细，因为现有用量记录没有关联消息或会话 ID。</p></section>
      </>}
    </div>
  );
}
