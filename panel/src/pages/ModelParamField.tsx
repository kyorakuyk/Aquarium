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
  onOverrideChange: (supported: boolean | undefined) => Promise<string | undefined>;
  className?: string;
  children: (disabled: boolean, title?: string) => ReactNode;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const controlDisabled = disabled || saving || capability === 'unsupported';
  const title = capability === 'unsupported' ? '该模型不支持' : undefined;
  const canConfirm = allowOverride && (source === 'unknown' || source === 'override');

  async function confirm(supported: boolean | undefined): Promise<void> {
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
      <ModelCapabilityStatus capability={capability} source={source} />
      {capability === 'unknown' && <small className="model-capability-help">未声明，可能被忽略</small>}
      {canConfirm && <div className="model-param-choices" role="group" aria-label={`${label}模型能力`}>
        <button type="button" className={override === true ? 'is-selected' : ''} aria-pressed={override === true} disabled={disabled || saving} onClick={() => void confirm(true)}>我确认支持</button>
        <button type="button" className={override === false ? 'is-selected' : ''} aria-pressed={override === false} disabled={disabled || saving} onClick={() => void confirm(false)}>我确认不支持</button>
        {override !== undefined && <button type="button" className="model-param-reset" disabled={disabled || saving} onClick={() => void confirm(undefined)}>恢复未声明</button>}
      </div>}
      {error && <small className="model-param-error" role="alert">{error}</small>}
    </div>
  );
}

export function ModelCapabilityStatus({ capability, source }: {
  capability: ModelCapability;
  source: ModelCapabilitySource;
}) {
  const status = capability === 'unknown'
    ? '未声明'
    : source === 'advertised'
      ? capability === 'supported' ? '已声明支持' : '不支持'
      : source === 'local'
        ? '不支持'
        : capability === 'supported' ? '已确认支持' : '已确认不支持';
  return <small className="model-capability-status">能力：{status}</small>;
}
