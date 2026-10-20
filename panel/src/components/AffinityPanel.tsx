import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { apiRequest, patch, type AffinityDetailView, type AffinityEventView, type AffinityLevel, type AffinityView } from '../api.ts';
import { redactSensitiveText } from '../sensitive-text.ts';

const LEVEL_LABELS: Record<AffinityLevel, string> = {
  cold: '疏远',
  cool: '偏冷',
  neutral: '普通',
  warm: '熟络',
  close: '亲近',
};

const SOURCE_LABELS: Record<AffinityEventView['source'], string> = {
  appraise: '情绪评估',
  called: '被叫',
  manual: '手动调整',
  band: '档位变化',
};

function formatTime(value: number | null): string {
  if (value === null) return '尚无自动互动';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(value);
}

function formatDelta(value: number): string {
  return `${value > 0 ? '+' : ''}${Number(value.toFixed(2))}`;
}

function eventSummary(event: AffinityEventView): string {
  const change = event.applied === event.delta
    ? formatDelta(event.applied)
    : `${formatDelta(event.applied)} / ${formatDelta(event.delta)} 原始`;
  return `${SOURCE_LABELS[event.source]} · ${change} · ${redactSensitiveText(event.reason)}`;
}

export function MemberAffinity({ affinity, account }: { affinity: AffinityView; account: number }) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<AffinityDetailView>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function toggle() {
    if (!expanded && !detail) {
      setLoading(true);
      try {
        const query = new URLSearchParams({ account: String(account) });
        setDetail(await apiRequest<AffinityDetailView>(`/api/affinity/${affinity.userId}?${query}`));
        setError('');
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : '读取好感事件失败');
      } finally {
        setLoading(false);
      }
    }
    setExpanded((value) => !value);
  }

  return (
    <div className="member-affinity">
      <button className="member-affinity-toggle" type="button" aria-expanded={expanded} aria-label={`好感度 ${affinity.value}，${LEVEL_LABELS[affinity.level]}；${expanded ? '收起事件' : '查看最近 5 条事件'}`} title="查看最近 5 条好感事件" onClick={() => void toggle()}>
        <progress max={100} value={affinity.value} aria-hidden="true" />
        <strong>{LEVEL_LABELS[affinity.level]}</strong>
        <span className="affinity-chevron" aria-hidden="true">{expanded ? '⌃' : '⌄'}</span>
      </button>
      {expanded && (loading
        ? <p className="muted">正在读取…</p>
        : error
          ? <p className="notice notice-warn" role="alert">{error}</p>
          : <ol className="affinity-event-list">
            {(detail?.events ?? []).slice(0, 5).map((event) => (
              <li key={event.id}><span className="mono muted">{formatTime(event.time)}</span> {eventSummary(event)}</li>
            ))}
            {detail?.events.length === 0 && <li className="muted">还没有好感事件。</li>}
          </ol>)}
    </div>
  );
}

export function AffinityPanel() {
  const [people, setPeople] = useState<AffinityView[]>([]);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [ascending, setAscending] = useState(false);
  const [busyUser, setBusyUser] = useState<number>();
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setPeople(await apiRequest<AffinityView[]>('/api/affinity'));
  }, []);

  useEffect(() => {
    void load().catch((reason: unknown) => setError(reason instanceof Error ? reason.message : '读取好感度失败'));
  }, [load]);

  const sortedPeople = [...people].sort((first, second) => ascending
    ? first.value - second.value || first.userId - second.userId
    : second.value - first.value || first.userId - second.userId);

  async function save(event: FormEvent<HTMLFormElement>, userId: number) {
    event.preventDefault();
    if (busyUser !== undefined) return;
    const value = Number(drafts[userId]);
    if (!Number.isInteger(value) || value < 0 || value > 100) {
      setError('好感度必须是 0–100 的整数');
      return;
    }
    setBusyUser(userId);
    try {
      await patch(`/api/affinity/${userId}`, { value });
      await load();
      setDrafts((current) => ({ ...current, [userId]: String(value) }));
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存好感度失败');
    } finally {
      setBusyUser(undefined);
    }
  }

  return (
    <section className="panel-card affinity-panel">
      <div className="section-heading">
        <div><h2>所有人</h2><p className="muted">关系按 QQ 账号跨群共享；回落值在读取时计算。</p></div>
        <button className="text-button" type="button" onClick={() => setAscending((value) => !value)}>
          数值{ascending ? '从低到高' : '从高到低'}
        </button>
      </div>
      {error && <div className="notice notice-warn" role="alert">{error}</div>}
      {sortedPeople.length === 0
        ? <p className="empty-state">还没有记录好感的群友。</p>
        : <div className="affinity-person-list">
          {sortedPeople.map((person) => {
            const name = person.name;
            return <article className="affinity-person-row" key={person.userId}>
              <div className="affinity-person-main">
                <strong>{name}</strong>
                <span className="mono muted">QQ {person.userId}</span>
                <span>{person.value} · {LEVEL_LABELS[person.level]}</span>
                <progress max={100} value={person.value} aria-label={`${name} 好感度 ${person.value}`} />
                <span className="muted">最近互动 · {formatTime(person.lastInteractionAt)}</span>
              </div>
              <form className="affinity-manual-form" onSubmit={(event) => void save(event, person.userId)}>
                <label><span className="field-label">手动设置</span><input
                  type="number"
                  min="0"
                  max="100"
                  step="1"
                  value={drafts[person.userId] ?? String(person.value)}
                  aria-label={`设置${name}的好感度`}
                  disabled={busyUser !== undefined}
                  onChange={(event) => setDrafts((current) => ({ ...current, [person.userId]: event.currentTarget.value }))}
                /></label>
                <button className="button button-secondary" type="submit" disabled={busyUser !== undefined}>保存</button>
              </form>
            </article>;
          })}
        </div>}
    </section>
  );
}
