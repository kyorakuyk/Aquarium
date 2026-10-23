import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { TagStatus, TagView } from '../api.ts';
import { containsSensitiveText, redactSensitiveText } from '../../../src/core/impressions/sensitive-text.ts';
import {
  confidenceLevel,
  knowledgeSourceLabel,
  memberIdentityInjectionLabel,
  recentTagFadeLabel,
  TAG_CATEGORY_LABELS,
  tagOriginLabel,
} from '../impressions-model.ts';

const STATUS_LABELS: Record<TagStatus, string> = {
  candidate: '候选',
  confirmed: '已确认',
  rejected: '已否决',
  superseded: '被推翻',
};

function formatTime(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(value);
}

function tagClass(tag: TagView): string {
  if (tag.status === 'rejected') return 'tag-rejected';
  if (tag.source === 'manual') return 'tag-manual';
  if (tag.status === 'candidate') return 'tag-candidate';
  if (tag.status === 'confirmed') return 'tag-confirmed';
  return 'tag-superseded';
}

function quotedText(value: string): string {
  return value.startsWith('「') && value.endsWith('」') ? value : `「${value}」`;
}

export function ImpressionTag({
  tag,
  displayText,
  busy,
  onAction,
  onRename,
  onLock,
  onDelete,
  appearance = 'default',
}: {
  tag: TagView;
  displayText?: string;
  busy: boolean;
  onAction: (id: number, status: TagStatus) => Promise<boolean>;
  onRename: (id: number, text: string) => Promise<boolean>;
  onLock?: (id: number, locked: boolean) => Promise<boolean>;
  onDelete?: (id: number) => Promise<boolean>;
  appearance?: 'default' | 'knowledge';
}) {
  const safeTagText = redactSensitiveText(tag.text);
  const subjectDisplay = tag.subject?.replaceAll('/', ' › ');
  const fallbackDisplay = subjectDisplay && (tag.category === 'topic' || tag.category === 'fandom')
    ? `${subjectDisplay} › ${tag.text}`
    : tag.text;
  const rawDisplayText = displayText ?? fallbackDisplay;
  const quotedTag = tag.category === 'meme' || tag.category === 'catchphrase';
  const safeDisplayText = redactSensitiveText(quotedTag ? quotedText(rawDisplayText) : rawDisplayText);
  const safePopoverTagText = quotedTag ? quotedText(safeTagText) : safeTagText;
  const safeQuotedTagText = quotedText(safeTagText);
  const safeSubject = tag.subject === null ? null : redactSensitiveText(tag.subject.replaceAll('/', ' › '));
  const identityInjectionLabel = memberIdentityInjectionLabel(tag);
  const isKnowledge = appearance === 'knowledge';
  const confidence = Number.isFinite(tag.activation) ? Math.min(1, Math.max(0, tag.activation)) : 0;
  const confidenceCaption = confidence >= 0.9 ? '很笃定'
    : confidence >= 0.8 ? '比较笃定'
      : confidence >= 0.6 ? '一般' : '还很弱';
  const knowledgeChipClass = [
    'k-chip',
    `k-chip-${confidenceLevel(tag.activation)}`,
    tag.status === 'candidate' ? 'is-candidate' : '',
    tag.status === 'rejected' ? 'is-rejected' : '',
    tag.source === 'manual' ? 'is-manual' : '',
    tag.locked ? 'is-locked' : '',
  ].filter(Boolean).join(' ');
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(safeTagText);
  const [sensitiveInput, setSensitiveInput] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const closePopover = () => {
    setOpen(false);
    setEditing(false);
    setDraft(safeTagText);
    setSensitiveInput(false);
  };

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) closePopover();
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') closePopover(); };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, safeTagText]);

  async function changeStatus(status: TagStatus) {
    if (await onAction(tag.id, status)) setOpen(false);
  }

  async function changeLock(): Promise<void> {
    if (onLock) await onLock(tag.id, !tag.locked);
  }

  async function deleteAndVeto(): Promise<void> {
    if (onDelete && await onDelete(tag.id)) closePopover();
  }

  async function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    if (containsSensitiveText(text)) {
      setDraft('');
      setSensitiveInput(true);
      return;
    }
    if (await onRename(tag.id, text)) {
      setEditing(false);
      setOpen(false);
      setSensitiveInput(false);
    }
  }

  return (
    <div className={`tag-chip-set${isKnowledge ? ' k-chip-set' : ''}`}>
      <div className="tag-popover-anchor" ref={root}>
      <button
        className={isKnowledge ? knowledgeChipClass : `tag-chip ${tagClass(tag)}`}
        type="button"
        disabled={busy}
        aria-label={`${safeDisplayText}，点开查看详情`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => { setDraft(safeTagText); setSensitiveInput(false); setEditing(false); setOpen((value) => !value); }}
      >
        {isKnowledge ? <>
          <span className="k-chip-label">{safeDisplayText}</span>
          {tag.status === 'candidate' && <span className="k-chip-samples mono">{tag.samples}/2</span>}
          {tag.source === 'manual' && <span className="k-chip-manual-dot" aria-label="手动" title="手动" />}
          {tag.locked && <span className="tag-lock-indicator" aria-hidden="true">锁</span>}
        </> : <>
          <span>{safeDisplayText}</span>
          {tag.status === 'candidate' && <span className="tag-samples mono">{tag.samples}/2</span>}
          {tag.locked && <span className="tag-lock-indicator" aria-hidden="true">锁</span>}
        </>}
      </button>
      {open && <div className={`tag-popover${isKnowledge ? ' k-chip-popover' : ''}`} role="dialog" aria-label={`${safePopoverTagText}标签详情`}>
        <div className="tag-popover-heading">
          {editing
            ? <form className="tag-rename-form" onSubmit={(event) => void rename(event)}>
              <input className="tag-rename" value={draft} maxLength={16} aria-label="修改标签文字" onChange={(event) => {
                const value = event.currentTarget.value;
                if (containsSensitiveText(value)) { setDraft(''); setSensitiveInput(true); }
                else { setDraft(value); setSensitiveInput(false); }
              }} />
              <button className="button button-primary" type="submit" disabled={busy || draft.trim().length === 0 || sensitiveInput}>保存</button>
              <button className="text-button" type="button" disabled={busy} onClick={() => { setEditing(false); setDraft(safeTagText); setSensitiveInput(false); }}>取消</button>
              {sensitiveInput && <span className="tag-sensitive-hint" role="status">疑似敏感凭据已清除，未发送。</span>}
            </form>
            : <strong>{safePopoverTagText}</strong>}
          <button className="tag-popover-close" type="button" aria-label="关闭标签详情" onClick={closePopover}>×</button>
        </div>
        <div className={`tag-popover-meta${isKnowledge ? ' k-chip-popover-meta' : ''}`}>
          <span className={`status-pill ${tagClass(tag)}`}>{STATUS_LABELS[tag.status]}{tag.locked && isKnowledge ? ' · 已锁定' : ''}</span>
          {isKnowledge && <div className="k-confidence-detail">
            <div><span>置信度</span><strong className="mono">{confidence.toFixed(2)} · {confidenceCaption}</strong></div>
            <progress max={1} value={confidence} aria-label={`置信度 ${confidence.toFixed(2)}`} />
          </div>}
          <span className="muted">来源：{isKnowledge
            ? knowledgeSourceLabel(tag)
            : tag.source === 'manual' ? '手动' : tagOriginLabel(tag.origin)}</span>
          {isKnowledge && <span className="mono muted">观察 {tag.samples} 次</span>}
          <span className="muted">{TAG_CATEGORY_LABELS[tag.category]}{safeSubject ? ` · ${safeSubject}` : ''}</span>
          {tag.polarity && <span className="muted">{tag.polarity === 'like' ? '喜欢' : '不喜欢'}</span>}
          {identityInjectionLabel && <span className="muted">{identityInjectionLabel}</span>}
          {isKnowledge && tag.category === 'recent' && recentTagFadeLabel(tag, Date.now())
            && <span className="muted">{recentTagFadeLabel(tag, Date.now())}</span>}
        </div>
        <ul className="tag-popover-evidence">
          {tag.evidence.slice(0, 3).map((item, index) => item.kind === 'signature'
            ? <li key={`signature:${item.fetchedAt}:${index}`}>
              <span>QQ 个性签名：{redactSensitiveText(item.text) || '（无签名）'}</span>
              <time className="mono muted">{formatTime(item.fetchedAt)}</time>
            </li>
            : <li key={item.messageId}>
              <span>{redactSensitiveText(item.quote) || '（无引文）'}</span><time className="mono muted">{formatTime(item.time)}</time>
            </li>)}
          {tag.evidence.length === 0 && <li className="muted">暂无观察证据。</li>}
        </ul>
        {!editing && <div className="tag-popover-actions">
          {tag.status !== 'confirmed' && <button className="button button-primary" type="button" disabled={busy} onClick={() => void changeStatus('confirmed')}>确认</button>}
          {tag.status !== 'rejected' && <button className="button button-secondary" type="button" disabled={busy} onClick={() => void changeStatus('rejected')}>否决</button>}
          {tag.status !== 'candidate' && <button className="button button-secondary" type="button" disabled={busy} onClick={() => void changeStatus('candidate')}>恢复为候选</button>}
          <button className="button button-secondary" type="button" disabled={busy} onClick={() => { setDraft(safeTagText); setSensitiveInput(false); setEditing(true); }}>改字</button>
          {isKnowledge && onLock && <button className="button button-secondary" type="button" disabled={busy} onClick={() => void changeLock()}>{tag.locked ? '解锁' : '锁定'}</button>}
          {onDelete && <button className="button button-warn" type="button" disabled={busy} onClick={() => void deleteAndVeto()}>删除并不再学</button>}
        </div>}
      </div>}
      </div>
      {!isKnowledge && onLock && <button
        className={`tag-lock-toggle${tag.locked ? ' is-locked' : ''}`}
        type="button"
        aria-label={`${tag.locked ? '解锁' : '加锁'}${safeQuotedTagText}`}
        title={tag.locked ? '解锁标签' : '锁定标签；不进入提示词'}
        disabled={busy}
        onClick={() => void changeLock()}
      ><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        <rect x="5" y="10" width="14" height="11" rx="2" />
        {tag.locked
          ? <path d="M8 10V7a4 4 0 0 1 8 0v3" />
          : <path d="M8 10V7a4 4 0 0 1 7.5-1.8" />}
      </svg></button>}
      {!isKnowledge && onDelete && <button
        className="tag-delete-toggle"
        type="button"
        aria-label={`删除并不再学${safeQuotedTagText}`}
        title="删除并不再学"
        disabled={busy}
        onClick={() => void onDelete(tag.id)}
      >×</button>}
    </div>
  );
}

export function InlineTagAdd({ label, busy, onSubmit }: {
  label: string;
  busy: boolean;
  onSubmit: (text: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [sensitiveInput, setSensitiveInput] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = text.trim();
    if (!value) return;
    if (containsSensitiveText(value)) {
      setText('');
      setSensitiveInput(true);
      return;
    }
    if (await onSubmit(value)) {
      setText('');
      setOpen(false);
      setSensitiveInput(false);
    }
  }

  if (!open) return <button className="tag-add-button" type="button" aria-label={label} title={label} disabled={busy} onClick={() => setOpen(true)}>＋</button>;

  return <form className="tag-add-inline" onSubmit={(event) => void submit(event)}>
    <input
      autoFocus
      value={text}
      maxLength={16}
      placeholder="2–16 字"
      aria-label={label}
      disabled={busy}
      onChange={(event) => {
        const value = event.currentTarget.value;
        if (containsSensitiveText(value)) { setText(''); setSensitiveInput(true); }
        else { setText(value); setSensitiveInput(false); }
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') { setText(''); setSensitiveInput(false); setOpen(false); }
      }}
    />
    <button className="button button-primary" type="submit" disabled={busy || text.trim().length === 0 || sensitiveInput}>添加</button>
    <button className="text-button" type="button" disabled={busy} onClick={() => { setText(''); setSensitiveInput(false); setOpen(false); }}>取消</button>
    {sensitiveInput && <span className="tag-sensitive-hint" role="status">疑似敏感凭据已清除，未发送。</span>}
  </form>;
}
