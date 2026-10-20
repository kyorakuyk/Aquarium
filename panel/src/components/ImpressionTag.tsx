import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { TagStatus, TagView } from '../api.ts';
import { containsSensitiveText, redactSensitiveText } from '../sensitive-text.ts';
import { memberIdentityInjectionLabel } from '../impressions-model.ts';

const STATUS_LABELS: Record<TagStatus, string> = {
  candidate: '候选',
  confirmed: '已确认',
  rejected: '已否决',
  superseded: '被推翻',
};

const CATEGORY_LABELS: Record<string, string> = {
  positioning: '定位', topic: '话题', atmosphere: '群氛围', meme: '群梗', norms: '规矩',
  identity: '自我认同', personality: '性格', fandom: '成分', speech: '说话风格', social: '社交方式',
  catchphrase: '口头禅', recent: '近况', dislike: '雷点', schedule: '作息', misc: '其他',
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
}: {
  tag: TagView;
  displayText?: string;
  busy: boolean;
  onAction: (id: number, status: TagStatus) => Promise<boolean>;
  onRename: (id: number, text: string) => Promise<boolean>;
  onLock?: (id: number, locked: boolean) => Promise<boolean>;
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
    <div className="tag-chip-set">
      <div className="tag-popover-anchor" ref={root}>
      <button
        className={`tag-chip ${tagClass(tag)}`}
        type="button"
        disabled={busy}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => { setDraft(safeTagText); setSensitiveInput(false); setEditing(false); setOpen((value) => !value); }}
      >
        <span>{safeDisplayText}</span>
        {tag.status === 'candidate' && <span className="tag-samples mono">{tag.samples}/2</span>}
        {tag.locked && <span className="tag-lock-indicator" aria-hidden="true">锁</span>}
      </button>
      {open && <div className="tag-popover" role="dialog" aria-label={`${safePopoverTagText}标签详情`}>
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
        <div className="tag-popover-meta">
          <span className={`status-pill ${tagClass(tag)}`}>{STATUS_LABELS[tag.status]}</span>
          {tag.source === 'manual' && <span className="muted">手动</span>}
          <span className="muted">{CATEGORY_LABELS[tag.category]}{safeSubject ? ` · ${safeSubject}` : ''}</span>
          {tag.polarity && <span className="muted">{tag.polarity === 'like' ? '喜欢' : '不喜欢'}</span>}
          {identityInjectionLabel && <span className="muted">{identityInjectionLabel}</span>}
          <span className="mono muted">观察 {tag.samples} 次 · 激活 {tag.activation.toFixed(2)}</span>
        </div>
        <ul className="tag-popover-evidence">
          {tag.evidence.slice(0, 3).map((item) => <li key={item.messageId}>
            <span>{redactSensitiveText(item.quote) || '（无引文）'}</span><time className="mono muted">{formatTime(item.time)}</time>
          </li>)}
          {tag.evidence.length === 0 && <li className="muted">暂无观察证据。</li>}
        </ul>
        {!editing && <div className="tag-popover-actions">
          {tag.status !== 'confirmed' && <button className="button button-primary" type="button" disabled={busy} onClick={() => void changeStatus('confirmed')}>确认</button>}
          {tag.status !== 'rejected' && <button className="button button-secondary" type="button" disabled={busy} onClick={() => void changeStatus('rejected')}>否决</button>}
          {tag.status !== 'candidate' && <button className="button button-secondary" type="button" disabled={busy} onClick={() => void changeStatus('candidate')}>恢复为候选</button>}
          <button className="button button-secondary" type="button" disabled={busy} onClick={() => { setDraft(safeTagText); setSensitiveInput(false); setEditing(true); }}>改字</button>
        </div>}
      </div>}
      </div>
      {onLock && <button
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
