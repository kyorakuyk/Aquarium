import { useEffect, useState } from 'react';
import {
  apiRequest,
  type ActivityCalendarView,
  type ActivityDistributionView,
  type ActivityResponseView,
  type ActivityView,
} from '../api.ts';
import { activityCalendarCells, activityLevel, peakActivityWindow } from '../impressions-model.ts';

const VIEW_LABELS: ReadonlyArray<{ value: ActivityView; label: string }> = [
  { value: 'hour', label: '时段' },
  { value: 'week', label: '周' },
  { value: 'month', label: '月' },
  { value: 'year', label: '年' },
];
const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];
const ACTIVITY_LEVELS = [0, 1, 2, 3, 4] as const;

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function DistributionChart({ data }: { data: ActivityDistributionView }) {
  const maximum = Math.max(0, ...data.buckets);
  if (data.view === 'hour') {
    return <div className="activity-distribution">
      <div className="activity-hour-grid" role="list" aria-label="一天中各小时的发言占比">
        {data.buckets.map((value, hour) => <span
          className={`activity-cell activity-level-${activityLevel(value, maximum)}`}
          key={hour}
          role="listitem"
          aria-label={`${hour}:00–${hour + 1}:00，${percent(value)}`}
          title={`${hour}:00–${hour + 1}:00 · ${percent(value)}`}
        />)}
      </div>
      <div className="activity-hour-axis" aria-hidden="true">
        {[0, 3, 6, 9, 12, 15, 18, 21, 24].map((hour) => <span key={hour}>{hour}</span>)}
      </div>
    </div>;
  }
  return <div className="activity-week-grid" role="list" aria-label="一周各日的发言占比">
    {data.buckets.map((value, index) => <div className="activity-week-day" key={index} role="listitem">
      <span
        className={`activity-week-cell activity-level-${activityLevel(value, maximum)}`}
        aria-label={`${WEEKDAYS[index]} · ${percent(value)}`}
        title={`${WEEKDAYS[index]} · ${percent(value)}`}
      />
      <span className="activity-week-label">{WEEKDAYS[index]}</span>
    </div>)}
  </div>;
}

function CalendarChart({ data }: { data: ActivityCalendarView }) {
  const cells = activityCalendarCells(data.buckets);
  const maximum = Math.max(0, ...data.buckets.map(({ count }) => count));
  const columns = Math.max(1, ...cells.map(({ week }) => week + 1));
  return <div className="activity-calendar-scroll">
    <div
      className={`activity-calendar-grid activity-calendar-${data.view}`}
      role="grid"
      aria-label={data.view === 'month' ? '近 30 天发言日历' : '近 365 天发言日历'}
      style={{ gridTemplateColumns: `repeat(${columns}, 11px)` }}
    >
      {cells.map((cell) => <span
        className={`activity-cell activity-level-${activityLevel(cell.count, maximum)}`}
        key={cell.date}
        role="gridcell"
        aria-label={`${cell.date} · ${cell.count} 条`}
        title={`${cell.date} · ${cell.count} 条`}
        style={{ gridColumn: cell.week + 1, gridRow: cell.weekday + 1 }}
      />)}
    </div>
  </div>;
}

function ActivitySummary({ data }: { data: ActivityResponseView }) {
  return <div className="activity-summary" aria-label="近 90 天统计">
    <span>近 90 天 <strong className="mono">{data.summary.total.toLocaleString('zh-CN')}</strong> 条</span>
    <span>平均 <strong className="mono">{data.summary.avgChars.toFixed(1)}</strong> 字</span>
    <span>含图 <strong className="mono">{percent(data.summary.imageRatio)}</strong></span>
  </div>;
}

export function ActivityHeatmap({ sessionId, userId, group = false, scheduleDrop = null, refreshVersion = 0 }: {
  sessionId: string;
  userId?: number;
  group?: boolean;
  scheduleDrop?: { text: string } | null;
  refreshVersion?: number;
}) {
  const [view, setView] = useState<ActivityView>('hour');
  const [data, setData] = useState<ActivityResponseView>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [suggestionHidden, setSuggestionHidden] = useState(false);
  const [suggestionMessage, setSuggestionMessage] = useState('');
  const [suggestionBusy, setSuggestionBusy] = useState(false);

  useEffect(() => {
    let active = true;
    const query = new URLSearchParams({ sessionId, view });
    if (userId !== undefined) query.set('userId', String(userId));
    setLoading(true);
    setData(undefined);
    setError('');
    void apiRequest<ActivityResponseView>(`/api/activity?${query.toString()}`).then((result) => {
      if (active) setData(result);
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : '读取出没统计失败');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [sessionId, userId, refreshVersion, view]);

  useEffect(() => {
    setSuggestionHidden(false);
    setSuggestionMessage('');
  }, [sessionId, userId, view]);

  async function updateSuggestion(action: 'apply' | 'dismiss'): Promise<void> {
    if (!group || data?.view !== 'hour' || !data.suggestion || suggestionBusy) return;
    setSuggestionBusy(true);
    setError('');
    try {
      await apiRequest(`/api/activity/suggestion/${action}`, {
        method: 'POST',
        body: JSON.stringify({ sessionId, windowKey: data.suggestion.windowKey }),
      });
      setSuggestionHidden(true);
      setSuggestionMessage(action === 'apply' ? '已加入该群的积极时段。' : '已关闭这条建议。');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '更新活动建议失败');
    } finally {
      setSuggestionBusy(false);
    }
  }

  const suggestion = group && data?.view === 'hour' ? data.suggestion : null;
  const peak = data?.view === 'hour' ? peakActivityWindow(data.buckets) : undefined;
  const peakFrom = peak ? String(peak.from).padStart(2, '0') : '';
  const peakTo = peak ? String(peak.to === 0 ? 24 : peak.to).padStart(2, '0') : '';
  return <section className={`activity-panel${group ? ' activity-panel-group' : ''}`}>
    <div className="activity-heading">
      <div>
        <h3>作息与出没</h3>
        {data && <p className="muted">{view === 'hour' || view === 'week' ? '近 90 天，占比' : view === 'month' ? '近 30 天，按本地日期' : '近 365 天，按本地日期'}</p>}
      </div>
      <div className="activity-view-tabs" role="group" aria-label="出没视图">
        {VIEW_LABELS.map((item) => <button
          className={view === item.value ? 'is-active' : ''}
          type="button"
          aria-pressed={view === item.value}
          key={item.value}
          onClick={() => setView(item.value)}
        >{item.label}</button>)}
      </div>
    </div>
    {error && <p className="notice notice-warn" role="alert">{error}</p>}
    {loading && !data && <p className="muted" role="status">正在读取出没统计…</p>}
    {!loading && !data && !error && <p className="muted">暂无出没数据。</p>}
    {data && (data.view === 'hour' || data.view === 'week') && <DistributionChart data={data} />}
    {data && (data.view === 'month' || data.view === 'year') && <CalendarChart data={data} />}
    {scheduleDrop && data?.view === 'hour' && peak && <p className="activity-schedule-drop" role="status">
      模型曾推测「{scheduleDrop.text}」，该作息提议已被统计规则丢弃。统计显示 {peakFrom}–{peakTo} 点最活跃；作息只认统计。
    </p>}
    {data && <div className="activity-legend" aria-label="颜色按相对发言量由少到多">
      <span>少</span>
      {ACTIVITY_LEVELS.map((level) => <span className={`activity-cell activity-level-${level}`} aria-hidden="true" key={level} />)}
      <span>多</span>
    </div>}
    {data && <ActivitySummary data={data} />}
    {suggestion && !suggestionHidden && <div className="activity-suggestion" role="status">
      <p>这个群 {suggestion.from}–{suggestion.to} 最热闹，要在这段设成积极吗？</p>
      <span className="activity-suggestion-ratio mono">{percent(suggestion.ratio)}</span>
      <button className="button button-primary" type="button" disabled={suggestionBusy} onClick={() => void updateSuggestion('apply')}>加入作息</button>
      <button className="text-button" type="button" disabled={suggestionBusy} onClick={() => void updateSuggestion('dismiss')}>关闭</button>
    </div>}
    {suggestionMessage && <p className="activity-suggestion-message" role="status">{suggestionMessage}</p>}
  </section>;
}
