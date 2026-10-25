import { useState } from 'react';
import { apiRequest, type TagStatus } from '../api.ts';
import type { ImpressionsViewWithCounterparts } from '../persona-counterpart-api.ts';
import { notifyPersonaCounterpartsUpdated } from '../persona-counterpart-events.ts';
import { redactSensitiveText } from '../../../src/core/impressions/sensitive-text.ts';
import { MemberTagRows, type MemberTagAdd } from './MemberTagRows.tsx';
import { ActivityHeatmap } from './ActivityHeatmap.tsx';
import { ImpressionSummaryEditor } from './ImpressionSummaryEditor.tsx';
import { MemberQqProfile } from './MemberQqProfile.tsx';
import { IdentityRelationsPanel } from './IdentityRelationsPanel.tsx';
import type { QqMemberTargetView } from '../api.ts';

const AFFINITY_LABELS: Record<ImpressionsViewWithCounterparts['members'][number]['affinity']['level'], string> = {
  enemy: '仇人',
  loathe: '憎恶',
  dislike: '讨厌',
  uncomfortable: '不爽',
  distant: '冷淡',
  unfamiliar: '不熟',
  acquaintance: '认识',
  ordinary_friend: '普通朋友',
  more_than_friends: '朋友以上',
  lover: '恋人',
};

type Member = ImpressionsViewWithCounterparts['members'][number];
type TagAction = (id: number, status: TagStatus) => Promise<boolean>;
type TagRename = (id: number, text: string) => Promise<boolean>;
type TagLock = (id: number, locked: boolean) => Promise<boolean>;
type TagDelete = (id: number) => Promise<boolean>;

export function MemberProfileCard({ sessionId, member, refreshVersion, busy, relationTargets, onIdentityUpdated, onAction, onRename, onLock, onDelete, onAdd }: {
  sessionId: string;
  member: Member;
  refreshVersion: number;
  busy: boolean;
  relationTargets: QqMemberTargetView[];
  onIdentityUpdated: () => Promise<unknown>;
  onAction: TagAction;
  onRename: TagRename;
  onLock: TagLock;
  onDelete: TagDelete;
  onAdd: MemberTagAdd;
}) {
  const summaryEndpoint = `/api/member-summaries/${encodeURIComponent(sessionId)}/${member.userId}`;
  const name = member.name;
  const [claimBusy, setClaimBusy] = useState('');
  const [claimError, setClaimError] = useState('');

  async function updateCounterpartClaim(
    claim: Member['counterpartClaims'][number],
    action: 'bind' | 'dismiss',
  ): Promise<void> {
    const key = `${claim.personaId}:${claim.counterpartName}:${claim.userId}`;
    if (claimBusy) return;
    setClaimBusy(key);
    setClaimError('');
    const endpoint = `/api/personas/${encodeURIComponent(claim.personaId)}`
      + `/counterparts/${encodeURIComponent(claim.counterpartName)}`;
    const accountQuery = `?account=${claim.account}`;
    try {
      if (action === 'bind') {
        await apiRequest(`${endpoint}/bindings${accountQuery}`, {
          method: 'POST',
          body: JSON.stringify({ userId: claim.userId }),
        });
      } else {
        await apiRequest(`${endpoint}/claims/${claim.userId}/dismiss${accountQuery}`, { method: 'POST' });
      }
      await onIdentityUpdated();
      notifyPersonaCounterpartsUpdated();
    } catch (reason) {
      setClaimError(reason instanceof Error ? reason.message : '更新待认领状态失败');
    } finally {
      setClaimBusy('');
    }
  }

  return <section className="panel-card member-profile-card" aria-label={`${name}的画像卡`}>
    <header className="member-profile-heading">
      <span className="member-profile-avatar" aria-hidden="true">{Array.from(name)[0] ?? '友'}</span>
      <div className="member-profile-title">
        <h2>{name}</h2>
        <span className="mono muted">QQ {member.userId}</span>
      </div>
      <span className="member-profile-affinity">{AFFINITY_LABELS[member.affinity.level]} · {member.affinity.value}</span>
      <ImpressionSummaryEditor endpoint={summaryEndpoint} subject={name} refreshVersion={refreshVersion} />
    </header>
    <ActivityHeatmap sessionId={sessionId} userId={member.userId} scheduleDrop={member.scheduleDrop} refreshVersion={refreshVersion} />
    {member.qqProfile && <MemberQqProfile profile={member.qqProfile} />}
    <IdentityRelationsPanel
      sessionId={sessionId}
      userId={member.userId}
      kind={member.kind}
      relations={member.relations}
      isRobot={member.qqProfile?.isRobot === true}
      targets={relationTargets}
      onUpdated={onIdentityUpdated}
    />
    {(member.counterpartClaims ?? []).length > 0 && <div className="member-counterpart-claims" aria-label="原作对象待认领">
      {(member.counterpartClaims ?? []).map((claim) => (
        <div className="member-counterpart-claim" key={`${claim.account}:${claim.personaId}:${claim.counterpartName}:${claim.userId}`}>
          <div className="member-counterpart-claim-copy">
            <span className="mono">QQ {claim.userId}</span>
            <strong>可能是「{claim.counterpartName}」</strong>
            <span className="muted">{redactSensitiveText(claim.senderName) || '未知昵称'} · {claim.evidence}</span>
            <time className="mono muted">{Math.floor(Math.max(0, Date.now() - claim.lastSeen) / 60_000) < 1
              ? '刚刚'
              : `${Math.floor(Math.max(0, Date.now() - claim.lastSeen) / 60_000)} 分钟前`}</time>
          </div>
          <div className="member-counterpart-claim-actions">
            <button className="button button-primary" type="button" disabled={busy || Boolean(claimBusy)} onClick={() => void updateCounterpartClaim(claim, 'bind')}>绑定</button>
            <button className="button button-secondary" type="button" disabled={busy || Boolean(claimBusy)} onClick={() => void updateCounterpartClaim(claim, 'dismiss')}>不是</button>
          </div>
        </div>
      ))}
      {claimError && <p className="member-counterpart-claim-error" role="alert">{claimError}</p>}
    </div>}
    <MemberTagRows
      sessionId={sessionId}
      tags={member.tags}
      busy={busy}
      onAction={onAction}
      onRename={onRename}
      onLock={onLock}
      onDelete={onDelete}
      onAdd={onAdd}
    />
    <details className="member-injected-tags">
      <summary>它眼里的这个人（实际注入的一行）</summary>
      <p>{member.memberTagsText
        ?? (member.memberTagsAllowed ? '没有符合条件的已确认标签。' : '当前隐私策略不会把此人的标签注入提示词。')}</p>
    </details>
  </section>;
}
