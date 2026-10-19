import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { ModelCapability, ModelCapabilitySource } from '../model-api.ts';
import { ModelCapabilityStatus } from './ModelParamField.tsx';

interface Position {
  left: number;
  top: number;
}

export function InlineModelParamCell({
  label,
  value,
  displayValue,
  variant = 'cell',
  capability,
  source,
  override,
  disabled,
  allowOverride,
  onCommit,
  onOverrideChange,
  children,
}: {
  label: string;
  value: string;
  displayValue?: string;
  variant?: 'cell' | 'pill';
  capability: ModelCapability;
  source: ModelCapabilitySource;
  override?: boolean;
  disabled: boolean;
  allowOverride: boolean;
  onCommit: (value: string) => Promise<string | undefined>;
  onOverrideChange: (supported: boolean | undefined) => Promise<string | undefined>;
  children: (value: string, onChange: (value: string) => void, disabled: boolean) => ReactNode;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const closeInFlight = useRef(false);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const [position, setPosition] = useState<Position>({ left: 12, top: 12 });
  const [saving, setSaving] = useState(false);
  const [overrideError, setOverrideError] = useState('');
  const [valueError, setValueError] = useState('');
  const effectiveDisabled = disabled || saving;
  const markedOverride = override === true ? 'supported' : override === false ? 'unsupported' : '';
  const visibleValue = capability === 'unsupported' ? '—' : (displayValue ?? (value || '默认'));
  const portalTarget = open ? triggerRef.current?.closest('dialog[open]') ?? document.body : document.body;

  function updatePosition(): void {
    const bounds = triggerRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const width = popoverRef.current?.offsetWidth ?? 240;
    const height = popoverRef.current?.offsetHeight ?? 224;
    const left = Math.max(8, Math.min(bounds.left, window.innerWidth - width - 8));
    const below = bounds.bottom + 6;
    const top = below + height <= window.innerHeight - 8
      ? below
      : Math.max(8, bounds.top - height - 6);
    setPosition({ left, top });
  }

  function openPopover(): void {
    if (disabled) return;
    setDraft(value);
    setValueError('');
    setOverrideError('');
    closeInFlight.current = false;
    setOpen(true);
  }

  async function commitAndClose(): Promise<void> {
    if (closeInFlight.current || disabled) return;
    closeInFlight.current = true;
    setSaving(true);
    setValueError('');
    try {
      const error = await onCommit(draft);
      if (error) {
        setValueError(error);
        closeInFlight.current = false;
        return;
      }
      setOpen(false);
    } finally {
      setSaving(false);
    }
  }

  async function setOverride(value: boolean | undefined): Promise<void> {
    if (!allowOverride || effectiveDisabled || source === 'advertised') return;
    setOverrideError('');
    setSaving(true);
    try {
      const error = await onOverrideChange(value);
      if (error) setOverrideError(error);
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    updatePosition();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && (triggerRef.current?.contains(target) || popoverRef.current?.contains(target))) return;
      void commitAndClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      void commitAndClose();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, draft, disabled, source, onCommit]);

  return (
    <>
      <button
        ref={triggerRef}
        className={`inline-param-trigger${variant === 'pill' ? ' slot-param-trigger' : ''}${capability === 'unsupported' ? ' is-unsupported' : ''}`}
        type="button"
        disabled={disabled}
        title={capability === 'unknown' ? '未声明，可能被忽略' : capability === 'unsupported' ? '该模型不支持' : undefined}
        aria-label={`${label}：${visibleValue}；${capability === 'unknown' ? '未声明，可能被忽略' : capability === 'unsupported' ? '不支持' : '支持'}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={openPopover}
      >
        {variant === 'pill' && <span className="slot-param-pill-label">{label}</span>}
        <span className="slot-param-pill-value">{capability === 'unsupported' ? <s>{visibleValue}</s> : visibleValue}</span>
        {capability === 'unknown' && <span className="param-unknown-marker" title="未声明，可能被忽略" aria-hidden="true">?</span>}
        {variant === 'pill' && <svg className="slot-param-pill-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>}
      </button>
      {open && createPortal(
        <div
          ref={popoverRef}
          className="model-param-popover"
          role="dialog"
          aria-label={`${label}参数编辑`}
          style={{ left: `${position.left}px`, top: `${position.top}px` }}
        >
          <div className="model-param-popover-input">
            <span className="model-param-popover-label">{label}</span>
            {children(draft, setDraft, effectiveDisabled || capability === 'unsupported')}
          </div>
          <div className="model-param-popover-capability">
            <ModelCapabilityStatus capability={capability} source={source} />
            <label className="model-param-override-select">
              <span>标记为…</span>
              <select
                aria-label={`${label}标记能力`}
                value={markedOverride}
                disabled={effectiveDisabled || !allowOverride || source === 'advertised'}
                title={source === 'advertised' ? '接口已声明能力，当前以接口声明为准' : undefined}
                onChange={(event) => {
                  const next = event.currentTarget.value;
                  void setOverride(next === 'supported' ? true : next === 'unsupported' ? false : undefined);
                }}
              >
                <option value="">标记为…</option>
                <option value="supported">支持</option>
                <option value="unsupported">不支持</option>
                <option value="reset">恢复未声明</option>
              </select>
            </label>
          </div>
          {overrideError && <small className="model-param-error" role="alert">{overrideError}</small>}
          {valueError && <small className="model-param-error" role="alert">{valueError}</small>}
          <div className="model-param-popover-footer">
            <button className="button button-primary" type="button" disabled={effectiveDisabled} onClick={() => void commitAndClose()}>
              {saving ? '保存中…' : '完成'}
            </button>
          </div>
        </div>,
        portalTarget,
      )}
    </>
  );
}
