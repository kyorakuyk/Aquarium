import { useState } from 'react';
import { apiRequest, type QqGroupProfileView } from '../api.ts';

const HONOR_LABELS: Record<NonNullable<QqGroupProfileView['honors']>[number]['kind'], string> = {
  dragon_king: '龙王',
  performer: '群聊之火',
  legend: '传奇',
  emotion: '快乐源泉',
  strong_newbie: '冒尖新人',
};

function dateFromSeconds(value: number | undefined): string {
  if (value === undefined || !Number.isSafeInteger(value) || value <= 0) return '—';
  return new Date(value * 1_000).toLocaleDateString('zh-CN');
}

function MemberComposition({ label, segments }: {
  label: string;
  segments: Array<{ label: string; value: number; tone: 'strong' | 'soft' | 'quiet' | 'muted' }>;
}) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  return <div className="qq-composition-row">
    <div className="qq-composition-bar" role="img" aria-label={`${label}：${segments.map(({ label: name, value }) => `${name} ${value}`).join('，')}`}>
      {segments.filter(({ value }) => value > 0).map((segment) => <span
        className={`qq-composition-segment is-${segment.tone}`}
        key={segment.label}
        style={{ flexGrow: segment.value }}
        title={`${segment.label} ${segment.value}`}
      />)}
      {total === 0 && <span className="qq-composition-segment is-empty" />}
    </div>
    <div className="qq-composition-legend">
      {segments.map((segment) => <span className="qq-composition-item" key={segment.label}>
        <span className={`qq-composition-dot is-${segment.tone}`} aria-hidden="true" />
        {segment.label} <strong className="mono">{segment.value}</strong>
      </span>)}
    </div>
  </div>;
}

export function QqGroupProfilePanel({ sessionId, profile, onReload }: {
  sessionId: string;
  profile: QqGroupProfileView | null;
  onReload: () => Promise<boolean>;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function refresh(): Promise<void> {
    if (refreshing) return;
    setRefreshing(true);
    setError('');
    setNotice('');
    try {
      const result = await apiRequest<{ refreshed: boolean }>(
        `/api/impressions/${encodeURIComponent(sessionId)}/refresh-qq-profile`,
        { method: 'POST' },
      );
      if (await onReload()) setNotice(result.refreshed ? '资料已更新。' : '账号离线，显示已有缓存。');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '刷新 QQ 资料失败');
    } finally {
      setRefreshing(false);
    }
  }

  const info = profile?.groupInfo;
  const composition = profile?.composition;
  return <div className="qq-group-profile-stack">
    <section className="panel-card qq-profile-panel" aria-labelledby="qq-group-profile-title">
      <header className="qq-profile-heading">
        <div><h2 id="qq-group-profile-title">群资料</h2><span className="muted">来自 QQ</span></div>
        <button className="button button-secondary" type="button" disabled={refreshing} onClick={() => void refresh()}>
          {refreshing ? '正在刷新…' : '刷新资料'}
        </button>
      </header>
      <dl className="qq-profile-grid">
        <div><dt>群名</dt><dd>{info?.groupName || '—'}</dd></div>
        <div><dt>人数</dt><dd className="mono">{info?.memberCount === undefined ? '—' : `${info.memberCount}${info.maxMemberCount === undefined ? '' : ` / ${info.maxMemberCount}`}`}</dd></div>
        <div><dt>建群</dt><dd className="mono">{dateFromSeconds(info?.groupCreateTime)}</dd></div>
        <div><dt>群等级</dt><dd className="mono">{info?.groupLevel === undefined ? '—' : `Lv.${info.groupLevel}`}</dd></div>
        <div className="qq-profile-wide"><dt>群简介</dt><dd>{info?.groupDescription || '—'}</dd></div>
      </dl>
    </section>

    <section className="panel-card qq-profile-panel" aria-labelledby="qq-group-qq-profile-title">
      <header className="qq-profile-heading">
        <div><h2 id="qq-group-qq-profile-title">QQ 资料</h2><span className="muted">来自 QQ</span></div>
        <span className="muted qq-profile-policy">性别、年龄、Q 龄、等级与入群时间不进提示词</span>
      </header>
      <div className="qq-profile-summary-grid">
        <div><span className="small-heading">精华消息</span><strong className="mono">{profile?.essenceCount ?? '—'}</strong></div>
        <div><span className="small-heading">地区</span><strong>QQ 不提供</strong></div>
      </div>
      <div className="qq-profile-detail-row">
        <span className="small-heading">最新公告</span>
        <p>{profile?.latestNotice || '—'}</p>
      </div>
      <div className="qq-profile-detail-row">
        <span className="small-heading">当前荣誉持有人</span>
        {profile?.honors === null || profile?.honors === undefined
          ? <p>—</p>
          : profile.honors.length === 0
            ? <p>暂无当前荣誉持有人</p>
            : <ul className="qq-honor-list">{profile.honors.map((honor, index) => <li key={`${honor.kind}:${honor.userId ?? honor.nickname ?? index}`}>
              <span>{HONOR_LABELS[honor.kind]}</span>
              <strong>{honor.nickname ?? (honor.userId === undefined ? '—' : String(honor.userId))}</strong>
            </li>)}</ul>}
      </div>
      <div className="qq-profile-detail-row">
        <span className="small-heading">成员构成</span>
        {composition
          ? <div className="qq-composition-grid">
            <MemberComposition label="性别" segments={[
              { label: '男', value: composition.sex.male, tone: 'strong' },
              { label: '女', value: composition.sex.female, tone: 'soft' },
              { label: '未公开', value: composition.sex.unknown, tone: 'quiet' },
            ]} />
            <MemberComposition label="入群时长" segments={[
              { label: '3 年以上', value: composition.joinDuration.overThreeYears, tone: 'strong' },
              { label: '1–3 年', value: composition.joinDuration.oneToThreeYears, tone: 'soft' },
              { label: '1 年内', value: composition.joinDuration.withinOneYear, tone: 'muted' },
              { label: '未知', value: composition.joinDuration.unknown, tone: 'quiet' },
            ]} />
          </div>
          : <p>—</p>}
      </div>
      {profile?.fetchedAt !== null && profile?.fetchedAt !== undefined && <p className="qq-profile-updated muted">
        上次同步 {new Date(profile.fetchedAt).toLocaleString('zh-CN')}
      </p>}
      {notice && <p className="notice" role="status">{notice}</p>}
      {error && <p className="notice notice-warn" role="alert">{error}</p>}
    </section>
  </div>;
}
