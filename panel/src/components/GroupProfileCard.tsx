import type { QqGroupProfileView, TagStatus, TagView } from '../api.ts';
import { ActivityHeatmap } from './ActivityHeatmap.tsx';
import { ImpressionSummaryEditor } from './ImpressionSummaryEditor.tsx';
import { MemberTagRows, type MemberTagAdd } from './MemberTagRows.tsx';
import { QqGroupProfilePanel } from './QqGroupProfilePanel.tsx';

type TagAction = (id: number, status: TagStatus) => Promise<boolean>;
type TagRename = (id: number, text: string) => Promise<boolean>;
type TagLock = (id: number, locked: boolean) => Promise<boolean>;
type TagDelete = (id: number) => Promise<boolean>;

export function GroupProfileCard({ sessionId, groupName, enabled, profile, tags, kinRelayTags = [], injectedText, scheduleDrop, refreshVersion, onReload, busy, onAction, onRename, onLock, onDelete, onAdd }: {
  sessionId: string;
  groupName: string;
  enabled: boolean;
  profile: QqGroupProfileView | null;
  tags: TagView[];
  kinRelayTags?: TagView[];
  injectedText: string | null;
  scheduleDrop: { text: string } | null;
  refreshVersion: number;
  onReload: () => Promise<boolean>;
  busy: boolean;
  onAction: TagAction;
  onRename: TagRename;
  onLock: TagLock;
  onDelete: TagDelete;
  onAdd: MemberTagAdd;
}) {
  const summaryEndpoint = `/api/group-summaries/${encodeURIComponent(sessionId)}`;
  return <section className="panel-card member-profile-card group-profile-card" aria-label={`${groupName}的群画像`}>
    <header className="member-profile-heading">
      <span className="member-profile-avatar" aria-hidden="true">{Array.from(groupName)[0] ?? '群'}</span>
      <div className="member-profile-title">
        <h2>{groupName}</h2>
        <span className="mono muted">群号 {sessionId.split(':').at(-1) ?? ''}</span>
      </div>
      <span className="status-pill">群聊 · {enabled ? '已启用' : '未启用'}</span>
      <ImpressionSummaryEditor endpoint={summaryEndpoint} subject="群" refreshVersion={refreshVersion} />
    </header>
    <ActivityHeatmap sessionId={sessionId} group scheduleDrop={scheduleDrop} refreshVersion={refreshVersion} />
    <QqGroupProfilePanel sessionId={sessionId} profile={profile} onReload={onReload} />
    <section className="group-profile-tags" aria-labelledby="group-profile-tags-title">
      <h3 id="group-profile-tags-title">分类标签</h3>
      <MemberTagRows
        sessionId={sessionId}
        tags={tags}
        busy={busy}
        onAction={onAction}
        onRename={onRename}
        onLock={onLock}
        onDelete={onDelete}
        onAdd={onAdd}
        scope="group"
      />
    </section>
    {kinRelayTags.length > 0 && <section className="kin-relay-tags" aria-labelledby="kin-relay-tags-title">
      <h3 id="kin-relay-tags-title">眷属转述</h3>
      <div className="kin-relay-tags-list">
        {kinRelayTags.map((tag) => <div className="kin-relay-tag-row" key={tag.id}>
          <span>{tag.text}</span>
          <span className="profile-tag-meta" aria-label={`来源 转述 · 眷属 ${tag.sourceAccount ?? '未知'}`}>
            <span className="profile-tag-meta-label">来源</span>
            <span className="profile-tag-meta-value">转述 · 眷属 {tag.sourceAccount ?? '未知'}</span>
          </span>
        </div>)}
      </div>
    </section>}
    <details className="member-injected-tags" open>
      <summary>它眼里的这个群（实际注入的一行）</summary>
      <small className="member-injected-tags-help">
        这行来自回复提示词的「群知识」段，可能包含本群符合注入条件的事实、同眷属其他账号可共享的群聊事实，以及经隐私策略授权转述的私聊事实。上方分类仅列本群知识标签；个人印象属于另一段提示词，不在此处。
      </small>
      <p>{injectedText ?? '没有符合条件的已确认标签。'}</p>
    </details>
    <ul className="impressions-tag-legend" aria-label="标签图例">
      <li>实线 = 已确认</li>
      <li>虚线 = 候选</li>
      <li>统计 = 本地算出，模型不能写</li>
      <li>锁 = 只给你看</li>
    </ul>
  </section>;
}
