import { useMemo, useState } from 'react';
import type { ViewImpression } from '../api.ts';
import { factPromotionUnavailableReason } from '../../../src/core/impressions/tag-model.ts';
import {
  groupPersonalImpressions,
  localizePromotionReason,
  personalImpressionRows,
  type PersonalImpressionEntry,
} from '../impressions-model.ts';
import { PersonalImpressionChip, type PersonalImpressionAction } from './PersonalImpressionChip.tsx';

function promotionReason(tag: ViewImpression): string | undefined {
  if (tag.status !== 'confirmed') return '仅已确认的印象可提升为知识';
  if (tag.sourceKind === null) return '来源会话无效，不能提升为知识';
  const reason = factPromotionUnavailableReason(tag.category, tag.userId === null ? 'group' : 'member', tag.sourceKind);
  return reason ? localizePromotionReason(reason, tag.category) : undefined;
}

export function PersonalImpressionsWorkspace({
  tags,
  pendingId,
  onAction,
}: {
  tags: ViewImpression[];
  pendingId?: number;
  onAction: (tag: ViewImpression, action: PersonalImpressionAction) => Promise<boolean>;
}) {
  const sessions = useMemo(() => groupPersonalImpressions(tags), [tags]);
  const entries = useMemo(() => sessions.flatMap((session) => [
    ...(session.group ? [session.group] : []),
    ...session.people,
  ]), [sessions]);
  const [selectedKey, setSelectedKey] = useState<string>();
  const activeEntry = entries.find((entry) => entry.key === selectedKey) ?? entries[0];

  const groupSessions = sessions.filter((session) => session.sourceKind === 'group');
  const privateSessions = sessions.filter((session) => session.sourceKind === 'private');
  const unknownSessions = sessions.filter((session) => session.sourceKind === null);
  const selectedEntryKey = activeEntry?.key;

  function renderEntry(entry: PersonalImpressionEntry) {
    return <button
      className={`personal-impressions-nav-item${entry.key === selectedEntryKey ? ' is-selected' : ''}`}
      key={entry.key}
      type="button"
      aria-current={entry.key === selectedEntryKey ? 'page' : undefined}
      onClick={() => setSelectedKey(entry.key)}
    >
      <span className="personal-impressions-nav-item-name">{entry.name}</span>
      <span className="personal-impressions-nav-count">{entry.tags.length}</span>
    </button>;
  }

  function renderSessions(entries: typeof sessions) {
    return entries.map((session) => <div className="personal-impressions-nav-session" key={session.key}>
      <p className="personal-impressions-nav-session-title">{session.sessionLabel}</p>
      {session.group && renderEntry(session.group)}
      {session.people.map(renderEntry)}
    </div>);
  }

  return <div className="personal-impressions-workspace">
    <nav className="personal-impressions-sidebar" aria-label="印象对象">
      {groupSessions.some((session) => session.group) && <section className="personal-impressions-nav-section">
        <h2>群</h2>
        {groupSessions.filter((session) => session.group).map((session) => renderEntry(session.group!))}
      </section>}
      {groupSessions.some((session) => session.people.length > 0) && <section className="personal-impressions-nav-section">
        <h2>群友</h2>
        {renderSessions(groupSessions.map((session) => ({ ...session, group: undefined })))}
      </section>}
      {privateSessions.length > 0 && <section className="personal-impressions-nav-section">
        <h2>私聊</h2>
        {renderSessions(privateSessions)}
      </section>}
      {unknownSessions.length > 0 && <section className="personal-impressions-nav-section">
        <h2>其他来源</h2>
        {renderSessions(unknownSessions)}
      </section>}
    </nav>

    {activeEntry ? <section className="panel-card personal-impressions-detail" aria-label={`${activeEntry.name}的印象`}>
      <header className="personal-impressions-detail-heading">
        <div className="personal-impressions-detail-avatar" aria-hidden="true">{activeEntry.name.slice(0, 1) || '印'}</div>
        <div>
          <h2>{activeEntry.name}</h2>
          <p>{activeEntry.sessionLabel} · {activeEntry.tags.length} 条印象</p>
        </div>
      </header>
      <div className="personal-impressions-detail-rows">
        {personalImpressionRows(activeEntry).map((row) => <section className="profile-tag-row personal-impression-category-row" key={row.key}>
          <h3 className="profile-tag-label">{row.label}</h3>
          <div className="profile-tag-content personal-impression-chip-list">
            {row.tags.map((tag) => <PersonalImpressionChip
              key={tag.id}
              tag={tag}
              reason={promotionReason(tag)}
              busy={pendingId === tag.id}
              onAction={onAction}
            />)}
          </div>
        </section>)}
      </div>
    </section> : <section className="panel-card personal-impressions-detail personal-impressions-detail-empty">
      还没有整理出的个人印象。
    </section>}
  </div>;
}
