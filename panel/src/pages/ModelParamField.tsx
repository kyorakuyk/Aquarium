import { useState, type ReactNode } from 'react';
import type { ModelCapability, ModelCapabilitySource } from '../model-api.ts';

export function ModelParamField({
  label,
  capability,
  source,
  override,
  disabled,
  allowOverride,
  onOverrideChange,
  className,
  children,
}: {
  label: string;
  capability: ModelCapability;
  source: ModelCapabilitySource;
  override?: boolean;
  disabled: boolean;
  allowOverride: boolean;
  onOverrideChange: (supported: boolean) => Promise<string | undefined>;
  className?: string;
  children: (disabled: boolean, title?: string) => ReactNode;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const controlDisabled = disabled || saving || capability === 'unsupported';
  const title = capability === 'unsupported' ? '该模型不支持' : undefined;
  const canConfirm = allowOverride && (source === 'unknown' || source === 'override');

  async function confirm(supported: boolean): Promise<void> {
    if (!canConfirm || disabled || saving) return;
    setSaving(true);
    setError('');
    try {
      const message = await onOverrideChange(supported);
      if (message) setError(message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={`model-param-field ${className ?? ''}`}>
      <label className="model-param-input">
        <span className="field-label">{label}</span>
        {children(controlDisabled, title)}
      </label>
      {capability === 'unknown' && <small className="model-param-note">未声明，可能被忽略</small>}
      {capability === 'unsupported' && <small className="model-param-note">该模型不支持</small>}
      {source === 'override' && <small className="model-param-note">能力由你确认</small>}
      {canConfirm && <div className="model-param-choices" role="group" aria-label={`${label}模型能力`}>
        <button type="button" className={override === true ? 'is-selected' : ''} aria-pressed={override === true} disabled={disabled || saving} onClick={() => void confirm(true)}>我确认支持</button>
        <button type="button" className={override === false ? 'is-selected' : ''} aria-pressed={override === false} disabled={disabled || saving} onClick={() => void confirm(false)}>我确认不支持</button>
      </div>}
      {error && <small className="model-param-error" role="alert">{error}</small>}
    </div>
  );
}
