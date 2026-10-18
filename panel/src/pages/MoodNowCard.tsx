import { useEffect, useState } from 'react';
import { apiRequest, type MoodBand } from '../api.ts';
import type { MoodSeriesPoint, MoodSeriesView } from '../mood-series-api.ts';

const bandLabels: Record<MoodBand, string> = {
  low: '低落',
  annoyed: '不爽',
  calm: '平静',
  happy: '开心',
  excited: '很开心',
};

const bandRanges: Array<{ band: MoodBand; min: number; max: number }> = [
  { band: 'low', min: -1, max: -0.5 },
  { band: 'annoyed', min: -0.5, max: -0.15 },
  { band: 'calm', min: -0.15, max: 0.15 },
  { band: 'happy', min: 0.15, max: 0.5 },
  { band: 'excited', min: 0.5, max: 1 },
];

function fullTime(time: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(time);
}

function Sparkline({ values, label }: { values: Array<number | null>; label: string }) {
  const width = 120;
  const height = 30;
  let penDown = false;
  const path = values.map((value, index) => {
    if (value === null) {
      penDown = false;
      return '';
    }
    const x = values.length <= 1 ? width / 2 : (index / (values.length - 1)) * width;
    const y = height - 3 - Math.max(0, Math.min(1, value)) * (height - 6);
    const command = `${penDown ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
    penDown = true;
    return command;
  }).filter(Boolean).join(' ');
  return (
    <svg className="mood-now-sparkline" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
      <path d={path} />
    </svg>
  );
}

function MoodChart({ series }: { series: MoodSeriesView }) {
  const width = 920;
  const height = 244;
  const left = 44;
  const right = 12;
  const top = 12;
  const bottom = 28;
  const innerWidth = width - left - right;
  const innerHeight = height - top - bottom;
  const x = (time: number) => left + ((time - series.from) / Math.max(1, series.to - series.from)) * innerWidth;
  const y = (value: number) => top + ((1 - value) / 2) * innerHeight;
  const line = series.points.map((point) => `${x(point.time).toFixed(1)},${y(point.valence).toFixed(1)}`).join(' ');

  return (
    <svg className="mood-now-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="过去 24 小时愉悦度曲线，背景分为五个心情档位">
      {bandRanges.map(({ band, min, max }) => (
        <rect
          className={`mood-now-band mood-now-band-${band}${series.current.band === band ? ' is-current' : ''}`}
          key={band}
          x={left}
          y={y(max)}
          width={innerWidth}
          height={Math.max(1, y(min) - y(max))}
        />
      ))}
      {[1, 0, -1].map((value) => (
        <g key={value}>
          <line className="mood-now-axis" x1={left} x2={left + innerWidth} y1={y(value)} y2={y(value)} />
          <text className="mood-now-axis-label" x={left - 9} y={y(value) + 4} textAnchor="end">{value.toFixed(1)}</text>
        </g>
      ))}
      {series.bandChanges.map((change) => (
        <line
          className="mood-now-transition"
          key={`${change.time}-${change.from}-${change.to}`}
          x1={x(change.time)}
          x2={x(change.time)}
          y1={top}
          y2={top + innerHeight}
        />
      ))}
      <polyline className="mood-now-valence-line" points={line} />
      {series.points.filter((point) => point.event).map((point) => (
        <circle className="mood-now-event-point" key={point.time} cx={x(point.time)} cy={y(point.valence)} r="3" />
      ))}
      <text className="mood-now-axis-label" x={left} y={height - 5}>24 小时前</text>
      <text className="mood-now-axis-label" x={left + innerWidth} y={height - 5} textAnchor="end">现在</text>
    </svg>
  );
}

function spacedArousal(points: MoodSeriesPoint[]): number[] {
  if (points.length === 0) return [];
  return Array.from({ length: 7 }, (_, index) => points[Math.round(index * (points.length - 1) / 6)]?.arousal ?? 0);
}

function energyStatus(status: MoodSeriesView['energy']['status']): string {
  if (status === 'asleep') return '睡着';
  if (status === 'woken') return '被叫醒';
  return '醒着';
}

export function MoodNowCard() {
  const [series, setSeries] = useState<MoodSeriesView>();
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    const refresh = () => {
      void apiRequest<MoodSeriesView>('/api/mood/series?hours=24').then((value) => {
        if (active) {
          setSeries(value);
          setError('');
        }
      }).catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : '读取此刻状态失败');
      });
    };
    refresh();
    const timer = window.setInterval(refresh, 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const arousalTrend = series ? spacedArousal(series.points) : [];
  const latestBlocks = series?.latestReply?.blocks;
  const blockRows = latestBlocks
    ? (['mood', 'float', 'affinity'] as const).flatMap((key) => {
      const text = latestBlocks[key];
      return text === null ? [] : [{ key, text }];
    })
    : [];

  return (
    <section className="panel-card mood-now-card section-block" aria-labelledby="mood-now-title">
      <div className="section-heading">
        <div><h2 id="mood-now-title">此刻</h2><p className="muted">情绪、精力与最近一次回复实际注入的内容</p></div>
        {series && <span className="muted mono">更新于 {fullTime(series.to)} · 30 秒刷新</span>}
      </div>
      {error && <div className="notice notice-warn" role="status">{error}{series ? '；保留上次数据。' : ''}</div>}
      {!series && !error && <p className="muted">正在读取此刻状态…</p>}
      {series && (
        <>
          <div className="mood-now-current">
            <div>
              <span className="muted">当前档位</span>
              <strong>{bandLabels[series.current.band]}</strong>
              <span className="muted">{series.current.bandSince === null ? '基线状态' : `从 ${fullTime(series.current.bandSince)} 起`}</span>
            </div>
            <div className="mood-now-distance">
              距{series.current.distanceToNextBand.direction === 'up' ? '升档' : '降档'}至 {bandLabels[series.current.distanceToNextBand.targetBand]}：
              <strong className="mono">{series.current.distanceToNextBand.amount.toFixed(2)}</strong>
              <span className="muted">{series.current.distanceToNextBand.friction === 'sliding' ? '滑动摩擦' : '静摩擦'}</span>
            </div>
          </div>
          <MoodChart series={series} />
          <div className="mood-now-metrics">
            <div className="mood-now-metric">
              <div className="metric-row"><span>兴奋度</span><strong className="mono">{Math.round(series.current.arousal * 100)}%</strong></div>
              <div className="progress-track" role="progressbar" aria-label="当前兴奋度" aria-valuenow={Math.round(series.current.arousal * 100)} aria-valuemin={0} aria-valuemax={100}>
                <span style={{ width: `${Math.round(series.current.arousal * 100)}%` }} />
              </div>
              <Sparkline values={arousalTrend} label="兴奋度七点趋势" />
            </div>
            <div className="mood-now-metric">
              <div className="metric-row"><span>精力 · {energyStatus(series.energy.status)}</span><strong className="mono">{series.energy.value === null ? '—' : `${Math.round(series.energy.value * 100)}%`}</strong></div>
              <div className="progress-track" role="progressbar" aria-label="当前精力" aria-valuenow={Math.round((series.energy.value ?? 0) * 100)} aria-valuemin={0} aria-valuemax={100} aria-valuetext={series.energy.value === null ? '睡着时不计算' : `${Math.round(series.energy.value * 100)}%`}>
                <span style={{ width: `${Math.round((series.energy.value ?? 0) * 100)}%` }} />
              </div>
              <Sparkline values={series.energy.points.map((point) => point.value)} label="精力七点趋势" />
            </div>
          </div>
          <div className="mood-now-injections">
            <div className="small-heading">此刻追加注入的块</div>
            {!series.latestReply && <p className="muted">暂无成功回复记录。</p>}
            {series.latestReply && blockRows.length === 0 && <p className="muted">最近一次回复没有注入 mood / float / affinity 块。</p>}
            {blockRows.length > 0 && (
              <div className="mood-now-blocks">
                {blockRows.map(({ key, text }) => (
                  <div className="mood-now-block" key={key}>
                    <span className="mono muted">{key}</span>
                    <pre>{text}</pre>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
