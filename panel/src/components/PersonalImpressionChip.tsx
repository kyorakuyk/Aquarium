import { useEffect, useRef, useState } from 'react';
import type { ViewImpression } from '../api.ts';
import { personalImpressionDisplayText, TAG_CATEGORY_LABELS, tagOriginLabel } from '../impressions-model.ts';

const STATUS_LABELS: Record<ViewImpression['status'], string> = {
  candidate: '待观察',
  confirmed: '已确认',
  rejected: '已忽略',
  superseded: '已替代',
};

export type PersonalImpressionAction = 'confirm' | 'delete' | 'promote';

export function PersonalImpressionChip({
  tag,
  reason,
  busy,
  onAction,
}: {
  tag: ViewImpression;
  reason?: string;
  busy: boolean;
  onAction: (tag: ViewImpression, action: PersonalImpressionAction) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  async function runAction(action: PersonalImpressionAction): Promise<void> {
    if (await onAction(tag, action)) setOpen(false);
  }

  const certainClass = tag.status === 'rejected' ? 'is-rejected'
    : tag.status === 'candidate' ? 'is-candidate'
      : tag.certain ? 'is-certain' : 'is-uncertain';
  const display = personalImpressionDisplayText(tag);
  const sourceKindLabel = tag.sourceKind === 'group' ? '群聊'
    : tag.sourceKind === 'private' ? '私聊' : '来源未知';

  return <div className="personal-impression-chip-anchor" ref={root}>
    <button
      className={`personal-impression-chip ${certainClass}`}
      type="button"
      disabled={busy}
      aria-label={`${display.title}，点开查看详情`}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => setOpen((value) => !value)}
    >
      <span className="personal-impression-chip-text">{display.text}</span>
      {display.showQuestion && <span className="personal-impression-chip-question" aria-hidden="true">?</span>}
      {tag.locked && <span className="tag-lock-indicator" aria-label="已锁定">锁</span>}
    </button>
    {open && <div className="tag-popover personal-impression-popover" role="dialog" aria-label={`${display.title}印象详情`}>
      <div className="tag-popover-heading">
        <strong>{display.title}</strong>
        <button className="tag-popover-close" type="button" aria-label="关闭印象详情" onClick={() => setOpen(false)}>×</button>
      </div>
      <dl className="personal-impression-detail-list">
        <div><dt>类别</dt><dd>{TAG_CATEGORY_LABELS[tag.category]}</dd></div>
        <div><dt>来源</dt><dd>{tag.source === 'manual' ? '手动' : tagOriginLabel(tag.origin)}</dd></div>
        <div><dt>状态</dt><dd>{STATUS_LABELS[tag.status]}{tag.locked ? ' · 已锁定' : ''}</dd></div>
        <div><dt>会话</dt><dd>{sourceKindLabel} · {tag.sessionLabel}</dd></div>
        {tag.userId !== null && <div><dt>对象</dt><dd>{tag.name} · {tag.userId}</dd></div>}
        {tag.polarity && <div><dt>倾向</dt><dd>{tag.polarity === 'like' ? '喜欢' : '不喜欢'}</dd></div>}
      </dl>
      <div className="tag-popover-actions">
        {!tag.certain && (tag.status === 'candidate' || tag.status === 'confirmed') && <button
          className="button button-secondary"
          type="button"
          disabled={busy}
          onClick={() => void runAction('confirm')}
        >确认为确定</button>}
        <div className="personal-impression-promote-action">
          <button
            className="button button-secondary"
            type="button"
            disabled={busy || Boolean(reason)}
            title={reason}
            aria-describedby={reason ? `promotion-reason-${tag.id}` : undefined}
            onClick={() => void runAction('promote')}
          >提升为知识</button>
          {reason && <small id={`promotion-reason-${tag.id}`} className="personal-impression-reason">{reason}</small>}
        </div>
        <button
          className="button button-warn"
          type="button"
          disabled={busy}
          onClick={() => void runAction('delete')}
        >删除印象</button>
      </div>
    </div>}
  </div>;
}
