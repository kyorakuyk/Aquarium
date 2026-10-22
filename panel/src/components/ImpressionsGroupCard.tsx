import { useEffect, useState } from 'react';
import { apiRequest, type ActivityDistributionView, type ImpressionsView, type SessionView } from '../api.ts';
import { activityLevel, peakActivityWindow } from '../impressions-model.ts';
import { redactSensitiveText } from '../../../src/core/impressions/sensitive-text.ts';

export function ImpressionsGroupCard({ group, view, selected, onSelect }: {
  group: SessionView;
  view: ImpressionsView;
  selected: boolean;
  onSelect: () => void;
}) {
  const [activity, setActivity] = useState<ActivityDistributionView>();
  const speakingMembers = view.members.filter((member) => member.messageCount > 0).length;
  const memberCount = group.memberCount ?? view.qqGroupProfile?.groupInfo?.memberCount;
  const positioning = view.groupTags.filter((tag) => tag.category === 'positioning'
    && tag.status === 'confirmed' && !tag.locked && tag.activation >= 0.25)
    .slice(0, 3);

  useEffect(() => {
    let active = true;
    setActivity(undefined);
    const query = new URLSearchParams({ sessionId: group.sessionId, view: 'hour' });
    void apiRequest<ActivityDistributionView>(`/api/activity?${query.toString()}`)
      .then((result) => { if (active && result.view === 'hour') setActivity(result); })
      .catch(() => { if (active) setActivity(undefined); });
    return () => { active = false; };
  }, [group.sessionId]);

  const peak = activity ? peakActivityWindow(activity.buckets) : undefined;
  const peakTo = peak?.to === 0 ? 24 : peak?.to;
  const maximum = Math.max(0, ...(activity?.buckets ?? []));
  return <button
    className={`impressions-group-card${selected ? ' is-selected' : ''}`}
    type="button"
    aria-pressed={selected}
    onClick={onSelect}
  >
    <span className="impressions-group-card-heading">
      <strong>{group.name}</strong>
      <span className="muted mono">{memberCount === undefined
        ? `有记录 ${speakingMembers} 人`
        : `${memberCount} 人 · 有记录 ${speakingMembers} 人`}</span>
    </span>
    {positioning.length > 0 && <span className="impressions-group-positioning">
      {positioning.map((tag) => <span className="tag-chip" key={tag.id}>{redactSensitiveText(tag.text)}</span>)}
    </span>}
    {activity && <span className="impressions-mini-activity" role="img" aria-label="近 90 天群聊时段分布">
      {activity.buckets.map((value, hour) => <span
        className={`activity-cell activity-level-${activityLevel(value, maximum)}`}
        key={hour}
        title={`${hour}:00–${hour + 1}:00`}
      />)}
    </span>}
    <span className="impressions-group-peak mono">{peak ? `最热 ${String(peak.from).padStart(2, '0')}–${String(peakTo).padStart(2, '0')} 点` : '暂无活跃时段'}</span>
  </button>;
}
