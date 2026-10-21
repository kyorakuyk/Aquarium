import type {
  ImpressionsView,
  QqMemberTargetView,
  TagCategory,
  TagPolarity,
  TagStatus,
  TagView,
} from '../api.ts';
import { GroupProfileCard } from './GroupProfileCard.tsx';
import { MemberProfileCard } from './MemberProfileCard.tsx';
import type { MemberTagAdd } from './MemberTagRows.tsx';

export function ImpressionsDetail({ sessionId, groupName, enabled, view, member, relationTargets, busy, onReload, onAction, onRename, onLock, onDelete, onAdd }: {
  sessionId: string;
  groupName: string;
  enabled: boolean;
  view: ImpressionsView;
  member: ImpressionsView['members'][number] | undefined;
  relationTargets: QqMemberTargetView[];
  busy: boolean;
  onReload: () => Promise<boolean>;
  onAction: (id: number, status: TagStatus) => Promise<boolean>;
  onRename: (id: number, text: string) => Promise<boolean>;
  onLock: (id: number, locked: boolean) => Promise<boolean>;
  onDelete: (id: number) => Promise<boolean>;
  onAdd: (userId: number | null, text: string, category?: TagCategory, subject?: string | null, polarity?: TagPolarity) => Promise<boolean>;
}) {
  const addMemberTag: MemberTagAdd = (text, category, subject, polarity) => onAdd(member?.userId ?? null, text, category, subject, polarity);
  if (!member) return <GroupProfileCard
    sessionId={sessionId}
    groupName={groupName}
    enabled={enabled}
    profile={view.qqGroupProfile}
    tags={view.groupTags}
    injectedText={view.groupTagsText}
    scheduleDrop={view.groupScheduleDrop}
    onReload={onReload}
    busy={busy}
    onAction={onAction}
    onRename={onRename}
    onLock={onLock}
    onDelete={onDelete}
    onAdd={addMemberTag}
  />;
  return <MemberProfileCard
    key={`${sessionId}:${member.userId}`}
    sessionId={sessionId}
    member={member}
    busy={busy}
    relationTargets={relationTargets}
    onIdentityUpdated={onReload}
    onAction={onAction}
    onRename={onRename}
    onLock={onLock}
    onDelete={onDelete}
    onAdd={addMemberTag}
  />;
}
