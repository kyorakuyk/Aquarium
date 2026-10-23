import { useState, type FormEvent } from 'react';
import { ImpressionTag } from './ImpressionTag.tsx';
import { TagSubjectManagerDialog } from './TagSubjectManagerDialog.tsx';
import { containsSensitiveText } from '../../../src/core/impressions/sensitive-text.ts';
import {
  knowledgeTags,
  memberIdentityMbti,
  TAG_CATEGORY_LABELS,
} from '../impressions-model.ts';
import type { TagCategory, TagPolarity, TagStatus, TagView } from '../api.ts';

export type MemberTagAdd = (
  text: string,
  category: TagCategory,
  subject: string | null,
  polarity: TagPolarity,
) => Promise<boolean>;

type TagAction = (id: number, status: TagStatus) => Promise<boolean>;
type TagRename = (id: number, text: string) => Promise<boolean>;
type TagLock = (id: number, locked: boolean) => Promise<boolean>;
type TagDelete = (id: number) => Promise<boolean>;

const PROFILE_ROWS: ReadonlyArray<TagCategory> = ['schedule', 'identity', 'fandom', 'catchphrase', 'recent'];

const GROUP_ROWS: ReadonlyArray<TagCategory> = ['schedule', 'positioning', 'topic', 'meme', 'norms', 'recent'];

function displayText(tag: TagView): string {
  return tag.category === 'fandom' && tag.subject
    ? `${tag.subject.replaceAll('/', ' › ')} › ${tag.text}`
    : tag.text;
}

function KnowledgeTagEntry({ tag, busy, onAction, onRename, onLock, onDelete }: {
  tag: TagView;
  busy: boolean;
  onAction: TagAction;
  onRename: TagRename;
  onLock: TagLock;
  onDelete: TagDelete;
}) {
  return <>
    <ImpressionTag
      tag={tag}
      displayText={displayText(tag)}
      appearance="knowledge"
      busy={busy}
      onAction={onAction}
      onRename={onRename}
      onLock={onLock}
      onDelete={onDelete}
    />
  </>;
}

function ProfileTagAdd({ label, category, busy, onSubmit, initialOpen = false, onDismiss }: {
  label: string;
  category: TagCategory;
  busy: boolean;
  onSubmit: MemberTagAdd;
  initialOpen?: boolean;
  onDismiss?: () => void;
}) {
  const [open, setOpen] = useState(initialOpen);
  const [text, setText] = useState('');
  const [subject, setSubject] = useState('');
  const [sensitiveInput, setSensitiveInput] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const cleanText = text.trim();
    const cleanSubject = subject.trim();
    if (!cleanText) return;
    if (containsSensitiveText(`${cleanText} ${cleanSubject}`)) {
      setText('');
      setSubject('');
      setSensitiveInput(true);
      return;
    }
    if (await onSubmit(cleanText, category, category === 'fandom' && cleanSubject ? cleanSubject : null, null)) {
      setText('');
      setSubject('');
      setSensitiveInput(false);
      setOpen(false);
      onDismiss?.();
    }
  }

  if (!open) return <button
    className="tag-add-button"
    type="button"
    aria-label={label}
    title={label}
    disabled={busy}
    onClick={() => setOpen(true)}
  >＋</button>;

  return <form className="profile-tag-add" onSubmit={(event) => void submit(event)}>
    <input
      autoFocus
      value={text}
      maxLength={16}
      placeholder="标签文字"
      aria-label={label}
      disabled={busy}
      onChange={(event) => {
        const value = event.currentTarget.value;
        if (containsSensitiveText(value)) { setText(''); setSensitiveInput(true); }
        else { setText(value); setSensitiveInput(false); }
      }}
    />
    {category === 'fandom' && <>
      <input
        value={subject}
        maxLength={40}
        placeholder="subject，如 游戏"
        aria-label={`${label}的 subject`}
        disabled={busy}
        onChange={(event) => {
          const value = event.currentTarget.value;
          if (containsSensitiveText(value)) { setSubject(''); setSensitiveInput(true); }
          else { setSubject(value); setSensitiveInput(false); }
        }}
      />
    </>}
    <button className="button button-primary" type="submit" disabled={busy || !text.trim() || sensitiveInput}>添加</button>
    <button className="text-button" type="button" disabled={busy} onClick={() => { setOpen(false); setText(''); setSubject(''); setSensitiveInput(false); onDismiss?.(); }}>取消</button>
    {sensitiveInput && <span className="tag-sensitive-hint" role="status">疑似敏感凭据已清除，未发送。</span>}
  </form>;
}

function TagRow({ label, category, tags, sessionId, busy, onAction, onRename, onLock, onDelete, onAdd }: {
  label: string;
  category: TagCategory;
  tags: TagView[];
  sessionId: string;
  busy: boolean;
  onAction: TagAction;
  onRename: TagRename;
  onLock: TagLock;
  onDelete: TagDelete;
  onAdd: MemberTagAdd;
}) {
  const [showRejected, setShowRejected] = useState(false);
  const [aliasesOpen, setAliasesOpen] = useState(false);
  const active = tags.filter((tag) => tag.status !== 'rejected');
  const rejected = tags.filter((tag) => tag.status === 'rejected');

  return <div className="profile-tag-row">
    <span className="profile-tag-label">{label}</span>
    <div className="profile-tag-content">
      {category === 'identity' && (() => {
        const identity = memberIdentityMbti(tags);
        return identity && <span className="profile-mbti" title={identity.title}>{identity.text}</span>;
      })()}
      {active.map((tag) => <KnowledgeTagEntry
        key={tag.id}
        tag={tag}
        busy={busy}
        onAction={onAction}
        onRename={onRename}
        onLock={onLock}
        onDelete={onDelete}
      />)}
      {category === 'fandom' && <button
        className="tag-more-button"
        type="button"
        aria-label="管理成分别名"
        title="管理成分别名"
        disabled={busy}
        onClick={() => setAliasesOpen(true)}
      >⋯</button>}
      <ProfileTagAdd
        label={`新增${label}标签`}
        category={category}
        busy={busy}
        onSubmit={onAdd}
      />
      {rejected.length > 0 && <button
        className="rejected-tags-toggle"
        type="button"
        aria-expanded={showRejected}
        onClick={() => setShowRejected((value) => !value)}
      >{showRejected ? '收起已否决' : `+${rejected.length} 已否决`}</button>}
      {showRejected && rejected.map((tag) => <KnowledgeTagEntry
        key={tag.id}
        tag={tag}
        busy={busy}
        onAction={onAction}
        onRename={onRename}
        onLock={onLock}
        onDelete={onDelete}
      />)}
    </div>
    {aliasesOpen && <TagSubjectManagerDialog
      open
      sessionId={sessionId}
      onClose={() => setAliasesOpen(false)}
    />}
  </div>;
}

export function MemberTagRows({ sessionId, tags, busy, onAction, onRename, onLock, onDelete, onAdd, scope = 'member' }: {
  sessionId: string;
  tags: TagView[];
  busy: boolean;
  onAction: TagAction;
  onRename: TagRename;
  onLock: TagLock;
  onDelete: TagDelete;
  onAdd: MemberTagAdd;
  scope?: 'member' | 'group';
}) {
  const visibleTags = knowledgeTags(tags);
  const [addingEmptyCategory, setAddingEmptyCategory] = useState<TagCategory>();
  const rows = scope === 'group' ? GROUP_ROWS : PROFILE_ROWS;
  const visibleRows = rows.filter((category) => visibleTags.some((tag) => tag.category === category));
  const emptyRows = rows.filter((category) => !visibleTags.some((tag) => tag.category === category));
  return <div className="profile-tag-rows">
    {visibleRows.map((category) => <TagRow
      key={category}
      label={TAG_CATEGORY_LABELS[category]}
      category={category}
      tags={visibleTags.filter((tag) => tag.category === category)}
      sessionId={sessionId}
      busy={busy}
      onAction={onAction}
      onRename={onRename}
      onLock={onLock}
      onDelete={onDelete}
      onAdd={onAdd}
    />)}
    {emptyRows.length > 0 && <div className="profile-tag-missing">
      <span className="profile-tag-missing-label">还没有：</span>
      {emptyRows.map((category) => <button
        className={`profile-tag-missing-action${addingEmptyCategory === category ? ' is-selected' : ''}`}
        key={category}
        type="button"
        disabled={busy}
        onClick={() => setAddingEmptyCategory(category)}
      >{TAG_CATEGORY_LABELS[category]} ＋</button>)}
    </div>}
    {addingEmptyCategory && <div className="profile-tag-empty-add">
      <strong className="profile-tag-add-label">{TAG_CATEGORY_LABELS[addingEmptyCategory]}</strong>
      <ProfileTagAdd
        key={addingEmptyCategory}
        label={`新增${TAG_CATEGORY_LABELS[addingEmptyCategory]}标签`}
        category={addingEmptyCategory}
        busy={busy}
        onSubmit={onAdd}
        initialOpen
        onDismiss={() => setAddingEmptyCategory(undefined)}
      />
    </div>}
  </div>;
}
