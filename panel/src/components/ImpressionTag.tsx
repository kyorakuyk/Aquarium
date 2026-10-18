import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { TagStatus, TagView } from '../api.ts';
import { containsSensitiveText, redactSensitiveText } from '../sensitive-text.ts';

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

export function ImpressionTag({
  tag,
  busy,
  onAction,
  onRename,
}: {
  tag: TagView;
  busy: boolean;
  onAction: (id: number, status: TagStatus) => Promise<boolean>;
  onRename: (id: number, text: string) => Promise<boolean>;
}) {
  const safeTagText = redactSensitiveText(tag.text);
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
    <div className="tag-popover-anchor" ref={root}>
      <button
        className={`tag-chip ${tagClass(tag)}`}
        type="button"
        disabled={busy}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => { setDraft(safeTagText); setSensitiveInput(false); setEditing(false); setOpen((value) => !value); }}
      >
        <span>{safeTagText}</span>
        {tag.status === 'candidate' && <span className="tag-samples mono">{tag.samples}/2</span>}
      </button>
      {open && <div className="tag-popover" role="dialog" aria-label={`${safeTagText}标签详情`}>
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
            : <strong>{safeTagText}</strong>}
          <button className="tag-popover-close" type="button" aria-label="关闭标签详情" onClick={closePopover}>×</button>
        </div>
        <div className="tag-popover-meta">
          <span className={`status-pill ${tagClass(tag)}`}>{STATUS_LABELS[tag.status]}</span>
          {tag.source === 'manual' && <span className="muted">手动</span>}
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
