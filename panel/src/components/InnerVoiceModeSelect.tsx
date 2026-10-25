import type { InnerVoiceMode, InnerVoiceSetting } from '../api.ts';

const MODE_OPTIONS: ReadonlyArray<{ value: InnerVoiceMode; label: string }> = [
  { value: 'full', label: '完整' },
  { value: 'light', label: '轻量' },
  { value: 'hidden', label: '隐藏' },
];

export function InnerVoiceModeSelect({
  id,
  value,
  allowInherit = false,
  disabled,
  className,
  ariaLabel,
  onChange,
}: {
  id: string;
  value: InnerVoiceSetting;
  allowInherit?: boolean;
  disabled: boolean;
  className?: string;
  ariaLabel: string;
  onChange: (value: InnerVoiceSetting) => void;
}) {
  return (
    <select
      id={id}
      className={className}
      value={value}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(event) => {
        const selected = event.currentTarget.value;
        if (selected === 'inherit' && allowInherit) onChange(selected);
        else if (MODE_OPTIONS.some((option) => option.value === selected)) onChange(selected as InnerVoiceMode);
      }}
    >
      {allowInherit && <option value="inherit">跟随人设</option>}
      {MODE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  );
}
