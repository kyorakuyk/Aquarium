import { useState, type FormEvent } from 'react';
import { ImpressionTag } from './ImpressionTag.tsx';
import { TagSubjectManagerDialog } from './TagSubjectManagerDialog.tsx';
import { containsSensitiveText } from '../sensitive-text.ts';
import {
  memberIdentityInjectionLabel,
  memberIdentityMbti,
  recentTagFadeLabel,
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

const PROFILE_ROWS: ReadonlyArray<{ category: TagCategory; label: string }> = [
  { category: 'identity', label: '自我认同' },
  { category: 'personality', label: '性格' },
  { category: 'fandom', label: '成分' },
  { category: 'speech', label: '说话风格' },
  { category: 'catchphrase', label: '口头禅' },
  { category: 'social', label: '社交方式' },
  { category: 'recent', label: '近况' },
  { category: 'dislike', label: '雷点' },
  { category: 'misc', label: '其他' },
];

function displayText(tag: TagView): string {
  const base = tag.category === 'fandom' && tag.subject
    ? `${tag.subject.replaceAll('/', ' › ')} › ${tag.text}${tag.polarity === 'dislike' ? ' · 不喜欢' : ''}`
    : tag.text;
  const badges = [
    memberIdentityInjectionLabel(tag) ?? '',
    tag.category === 'identity' && tag.origin === 'self_report' ? `自述 ×${tag.samples}` : '',
    tag.category === 'schedule' && tag.source === 'auto' ? '自动' : '',
    tag.category === 'recent' ? recentTagFadeLabel(tag, Date.now()) ?? '' : '',
  ].filter(Boolean);
  return badges.length > 0 ? `${base} · ${badges.join(' · ')}` : base;
}

function ProfileTagAdd({ label, category, busy, onSubmit }: {
  label: string;
  category: TagCategory;
  busy: boolean;
  onSubmit: MemberTagAdd;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [subject, setSubject] = useState('');
  const [polarity, setPolarity] = useState<'' | 'like' | 'dislike'>('');
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
    if (await onSubmit(cleanText, category, category === 'fandom' && cleanSubject ? cleanSubject : null, polarity || null)) {
      setText('');
      setSubject('');
      setPolarity('');
      setSensitiveInput(false);
      setOpen(false);
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
      <select aria-label={`${label}的极性`} value={polarity} disabled={busy} onChange={(event) => setPolarity(event.currentTarget.value as typeof polarity)}>
        <option value="">未设置</option>
        <option value="like">喜欢</option>
        <option value="dislike">不喜欢</option>
      </select>
    </>}
    <button className="button button-primary" type="submit" disabled={busy || !text.trim() || sensitiveInput}>添加</button>
    <button className="text-button" type="button" disabled={busy} onClick={() => { setOpen(false); setText(''); setSubject(''); setPolarity(''); setSensitiveInput(false); }}>取消</button>
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
      {active.map((tag) => <ImpressionTag
        key={tag.id}
        tag={tag}
        displayText={displayText(tag)}
        busy={busy}
        onAction={onAction}
        onRename={onRename}
        onLock={onLock}
        onDelete={onDelete}
      />)}
      {active.length === 0 && <span className="muted profile-tag-empty">暂无</span>}
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
      {showRejected && rejected.map((tag) => <ImpressionTag
        key={tag.id}
        tag={tag}
        displayText={displayText(tag)}
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

export function MemberTagRows({ sessionId, tags, busy, onAction, onRename, onLock, onDelete, onAdd }: {
  sessionId: string;
  tags: TagView[];
  busy: boolean;
  onAction: TagAction;
  onRename: TagRename;
  onLock: TagLock;
  onDelete: TagDelete;
  onAdd: MemberTagAdd;
}) {
  const scheduleTags = tags.filter((tag) => tag.category === 'schedule');
  return <div className="profile-tag-rows">
    <TagRow
      label="作息"
      category="schedule"
      tags={scheduleTags}
      sessionId={sessionId}
      busy={busy}
      onAction={onAction}
      onRename={onRename}
      onLock={onLock}
      onDelete={onDelete}
      onAdd={onAdd}
    />
    {PROFILE_ROWS.map(({ category, label }) => <TagRow
      key={category}
      label={label}
      category={category}
      tags={tags.filter((tag) => tag.category === category)}
      sessionId={sessionId}
      busy={busy}
      onAction={onAction}
      onRename={onRename}
      onLock={onLock}
      onDelete={onDelete}
      onAdd={onAdd}
    />)}
  </div>;
}
