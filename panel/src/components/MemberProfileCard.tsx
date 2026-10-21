import type { ImpressionsView, TagStatus } from '../api.ts';
import { MemberTagRows, type MemberTagAdd } from './MemberTagRows.tsx';
import { ActivityHeatmap } from './ActivityHeatmap.tsx';
import { ImpressionSummaryEditor } from './ImpressionSummaryEditor.tsx';
import { MemberQqProfile } from './MemberQqProfile.tsx';
import { IdentityRelationsPanel } from './IdentityRelationsPanel.tsx';
import type { QqMemberTargetView } from '../api.ts';

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
