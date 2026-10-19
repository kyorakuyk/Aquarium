import type { ModelReasoning } from '../api.ts';
import { REASONING_OPTIONS } from '../models-view.ts';

export function TemperatureParameterControls({ value, fallback, disabled, onChange }: {
  value: string;
  fallback: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="slot-temperature-editor">
      <div className="slot-param-popover-heading"><strong>温度</strong><span className="mono">0 – 2</span></div>
      <div className="slot-temperature-controls">
        <input
          className="slot-temperature-range"
          type="range"
          min={0}
          max={2}
          step={0.1}
          value={value || fallback}
          aria-label="温度滑块"
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
        <input
          className="slot-temperature-number mono"
          type="number"
          min={0}
          max={2}
          step={0.1}
          value={value || fallback}
          aria-label="温度数值"
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      </div>
      <label className="slot-param-default">
        <input type="checkbox" checked={!value} disabled={disabled} onChange={(event) => onChange(event.currentTarget.checked ? '' : value || fallback)} />
        使用默认值
      </label>
    </div>
  );
}

export function ReasoningParameterControls({ value, disabled, onChange }: {
  value: ModelReasoning;
  disabled: boolean;
  onChange: (value: ModelReasoning) => void;
}) {
  return (
    <div className="slot-reasoning-editor" role="group" aria-label="思考强度">
      {REASONING_OPTIONS.map((option) => <button
        type="button"
        key={option.value}
        className={value === option.value ? 'is-selected' : ''}
        aria-pressed={value === option.value}
        disabled={disabled}
        onClick={() => onChange(option.value)}
      >{option.label}</button>)}
    </div>
  );
}

export function MaxTokensParameterControls({ value, fallback, disabled, onChange }: {
  value: string;
  fallback: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="slot-max-tokens-editor">
      <input
        className="mono"
        type="number"
        min={1}
        step={1}
        value={value || fallback}
        aria-label="最大长度"
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      <label className="slot-param-default">
        <input type="checkbox" checked={!value} disabled={disabled} onChange={(event) => onChange(event.currentTarget.checked ? '' : value || fallback)} />
        使用默认值
      </label>
    </div>
  );
}
