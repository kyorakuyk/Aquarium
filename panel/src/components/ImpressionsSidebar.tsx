import { useMemo, useState } from 'react';
import type { ImpressionsView, SessionView } from '../api.ts';
import { searchAndSortMembers, type ImpressionsMemberSort } from '../impressions-model.ts';
import { ImpressionsGroupCard } from './ImpressionsGroupCard.tsx';
import { ImpressionsMemberRow } from './ImpressionsMemberRow.tsx';

export function ImpressionsSidebar({ group, view, selectedUserId, onSelectGroup, onSelectMember }: {
  group: SessionView;
  view: ImpressionsView;
  selectedUserId: number | undefined;
  onSelectGroup: () => void;
  onSelectMember: (userId: number) => void;
}) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<ImpressionsMemberSort>('recent');
  const [showSilent, setShowSilent] = useState(false);
  const account = Number(view.sessionId.split(':', 1)[0]);
  const filtered = useMemo(() => searchAndSortMembers(view.members, query, sort), [view.members, query, sort]);
  const speaking = filtered.filter((member) => member.messageCount > 0);
  const silent = filtered.filter((member) => member.messageCount === 0);
  const speakingTotal = view.members.filter((member) => member.messageCount > 0).length;
  const knownSilentTotal = view.members.filter((member) => member.messageCount === 0).length;
  const memberCount = group.memberCount ?? view.qqGroupProfile?.groupInfo?.memberCount;
  const silentTotal = Math.max(knownSilentTotal, memberCount === undefined ? 0 : memberCount - speakingTotal);
  const silentWithoutRoster = silentTotal - knownSilentTotal;

  return <aside className="impressions-sidebar">
    <section className="panel-card impressions-sidebar-box" aria-label="群友列表">
      <ImpressionsGroupCard group={group} view={view} selected={selectedUserId === undefined} onSelect={onSelectGroup} />
      <div className="impressions-member-tools">
        <label className="impressions-member-search">
          <span className="visually-hidden">搜索群友名字、群名片或标签</span>
          <input type="search" value={query} placeholder="搜索群友、群名片或标签" onChange={(event) => setQuery(event.currentTarget.value)} />
        </label>
        <label className="impressions-member-sort">
          <span className="visually-hidden">群友排序方式</span>
          <select value={sort} onChange={(event) => setSort(event.currentTarget.value as ImpressionsMemberSort)}>
            <option value="recent">最近发言</option>
            <option value="messages">发言量</option>
            <option value="affinity">好感度</option>
          </select>
        </label>
      </div>
      <div className="impressions-member-list">
        <div className="section-heading">
          <h2>群友 · 有记录 <span className="mono">{speakingTotal}</span> 人</h2>
          <span className="muted mono">{speaking.length} 人</span>
        </div>
        {speaking.length === 0 && <p className="muted impressions-list-empty">{query ? '没有匹配的发言成员。' : '群里还没有发言记录。'}</p>}
        <div className="member-list">
          {speaking.map((member) => <ImpressionsMemberRow
            key={member.userId}
            member={member}
            account={account}
            selected={member.userId === selectedUserId}
            onSelect={() => onSelectMember(member.userId)}
          />)}
        </div>
        {silentTotal > 0 && <>
          <button className="impressions-silent-toggle" type="button" aria-expanded={showSilent} onClick={() => setShowSilent((value) => !value)}>
            另有 <span className="mono">{silentTotal}</span> 人还没说过话 · {showSilent ? '收起' : '显示'}
          </button>
          {showSilent && <div className="member-list">
            {silent.map((member) => <ImpressionsMemberRow
              key={member.userId}
              member={member}
              account={account}
              selected={member.userId === selectedUserId}
              onSelect={() => onSelectMember(member.userId)}
            />)}
          </div>}
          {showSilent && silentWithoutRoster > 0 && <p className="muted impressions-list-empty">
            还有 <span className="mono">{silentWithoutRoster}</span> 位成员尚未同步到名单；刷新 QQ 资料后可查看姓名。
          </p>}
        </>}
      </div>
    </section>
  </aside>;
}
