import { useEffect, useState } from 'react';
import {
  apiRequest,
  type ImpressionsView,
  type MemberSummaryView,
  type TagStatus,
} from '../api.ts';
import { MemberTagRows, type MemberTagAdd } from './MemberTagRows.tsx';
import { ActivityHeatmap } from './ActivityHeatmap.tsx';
import { containsSensitiveText, redactSensitiveText } from '../sensitive-text.ts';

const AFFINITY_LABELS: Record<ImpressionsView['members'][number]['affinity']['level'], string> = {
  cold: '疏远',
  cool: '偏冷',
  neutral: '普通',
  warm: '熟络',
  close: '亲近',
};

type Member = ImpressionsView['members'][number];
type TagAction = (id: number, status: TagStatus) => Promise<boolean>;
type TagRename = (id: number, text: string) => Promise<boolean>;
type TagLock = (id: number, locked: boolean) => Promise<boolean>;

export function MemberProfileCard({ sessionId, member, busy, onAction, onRename, onLock, onAdd }: {
  sessionId: string;
  member: Member;
  busy: boolean;
  onAction: TagAction;
  onRename: TagRename;
  onLock: TagLock;
  onAdd: MemberTagAdd;
}) {
  const [summary, setSummary] = useState<MemberSummaryView | null>();
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [summaryEditing, setSummaryEditing] = useState(false);
  const [summaryDraft, setSummaryDraft] = useState('');
  const [summarySensitiveInput, setSummarySensitiveInput] = useState(false);
  const [summarySaving, setSummarySaving] = useState(false);
  const [summaryError, setSummaryError] = useState('');

  const summaryEndpoint = `/api/member-summaries/${encodeURIComponent(sessionId)}/${member.userId}`;
  useEffect(() => {
    let active = true;
    setSummaryLoading(true);
    setSummaryError('');
    setSummaryEditing(false);
    void apiRequest<MemberSummaryView | null>(summaryEndpoint).then((result) => {
      if (active) setSummary(result);
    }).catch((reason: unknown) => {
      if (active) setSummaryError(reason instanceof Error ? reason.message : '读取一句话印象失败');
    }).finally(() => {
      if (active) setSummaryLoading(false);
    });
    return () => { active = false; };
  }, [summaryEndpoint]);

  async function saveSummary(): Promise<void> {
    const text = summaryDraft.trim();
    if (!text || Array.from(text).length > 50 || /[\r\n]/u.test(text) || containsSensitiveText(text) || summarySaving) return;
    setSummarySaving(true);
    setSummaryError('');
    try {
      const saved = await apiRequest<MemberSummaryView>(summaryEndpoint, {
        method: 'PUT',
        body: JSON.stringify({ text }),
      });
      setSummary(saved);
      setSummaryEditing(false);
    } catch (reason) {
      setSummaryError(reason instanceof Error ? reason.message : '保存一句话印象失败');
    } finally {
      setSummarySaving(false);
    }
  }

  const safeName = redactSensitiveText(member.name);
  return <section className="panel-card member-profile-card" aria-label={`${safeName}的画像卡`}>
    <header className="member-profile-heading">
      <span className="member-profile-avatar" aria-hidden="true">{Array.from(safeName)[0] ?? '友'}</span>
      <div className="member-profile-title">
        <h2>{safeName}</h2>
        <span className="mono muted">QQ {member.userId}</span>
      </div>
      <span className="member-profile-affinity">{AFFINITY_LABELS[member.affinity.level]} · {member.affinity.value}</span>
      <div className="member-summary">
        <div className="member-summary-heading">
          <span className="small-heading">一句话印象</span>
          {summary?.manual && <span className="status-pill">手动</span>}
          {!summaryEditing && <button className="text-button" type="button" disabled={summaryLoading || summarySaving} onClick={() => {
            setSummaryDraft(summary?.text ?? '');
            setSummarySensitiveInput(false);
            setSummaryEditing(true);
          }}>{summary ? '改写' : '添加'}</button>}
        </div>
        {summaryLoading && <p className="muted" role="status">正在读取…</p>}
        {!summaryLoading && !summaryEditing && <p className="member-summary-text">
          {summary ? redactSensitiveText(summary.text) : '还没有一句话印象。'}
        </p>}
        {summaryEditing && <div className="member-summary-editor">
          <textarea
            value={summaryDraft}
            rows={2}
            aria-label="编辑一句话印象"
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (containsSensitiveText(value)) {
                setSummaryDraft('');
                setSummarySensitiveInput(true);
                setSummaryError('疑似敏感凭据已清除，未发送。');
              } else {
                setSummaryDraft(value);
                setSummarySensitiveInput(false);
                setSummaryError('');
              }
            }}
          />
          <span className="muted">{Array.from(summaryDraft).length}/50 个 Unicode 字符</span>
          {summarySensitiveInput && <span className="tag-sensitive-hint" role="status">疑似敏感凭据已清除，未发送。</span>}
          <div className="member-summary-actions">
            <button className="button button-primary" type="button" disabled={summarySaving || summarySensitiveInput || !summaryDraft.trim() || Array.from(summaryDraft.trim()).length > 50 || /[\r\n]/u.test(summaryDraft)} onClick={() => void saveSummary()}>
              {summarySaving ? '正在保存…' : '保存为手动印象'}
            </button>
            <button className="text-button" type="button" disabled={summarySaving} onClick={() => { setSummaryEditing(false); setSummarySensitiveInput(false); setSummaryError(''); }}>取消</button>
          </div>
        </div>}
        {summaryError && <p className="notice notice-warn" role="alert">{summaryError}</p>}
      </div>
    </header>
    <ActivityHeatmap sessionId={sessionId} userId={member.userId} />
    <MemberTagRows
      sessionId={sessionId}
      tags={member.tags}
      busy={busy}
      onAction={onAction}
      onRename={onRename}
      onLock={onLock}
      onAdd={onAdd}
    />
    <details className="member-injected-tags">
      <summary>它眼里的这个人（实际注入的一行）</summary>
      <p>{member.memberTagsText
        ?? (member.memberTagsAllowed ? '没有符合条件的已确认标签。' : '当前隐私策略不会把此人的标签注入提示词。')}</p>
    </details>
  </section>;
}
