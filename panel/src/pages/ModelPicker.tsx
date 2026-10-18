import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { ModelProviderView } from '../api.ts';
import type { ProviderModelsState } from '../model-api.ts';

export function ModelPicker({
  provider,
  value,
  label,
  state,
  disabled,
  onLoad,
  onChange,
}: {
  provider: ModelProviderView | undefined;
  value: string;
  label: string;
  state: ProviderModelsState | undefined;
  disabled: boolean;
  onLoad: (provider: ModelProviderView, refresh?: boolean) => Promise<unknown>;
  onChange: (value: string) => void;
}) {
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<number | undefined>(undefined);
  const isApi = provider?.kind === 'api';
  const failed = state?.status === 'error' || Boolean(state?.data?.error);
  const failureMessage = state?.status === 'error' ? state.error : state?.data?.error;
  const models = failed ? [] : state?.data?.models ?? [];
  const filtered = models.filter((model) => model.id.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 60);
  const customValue = query.trim();
  const exactMatch = models.some((model) => model.id === customValue);

  useEffect(() => {
    setQuery(value);
  }, [provider?.id, value]);

  useEffect(() => () => {
    if (closeTimer.current !== undefined) window.clearTimeout(closeTimer.current);
  }, []);

  function openPicker(): void {
    if (!provider || provider.kind !== 'api') return;
    if (closeTimer.current !== undefined) window.clearTimeout(closeTimer.current);
    closeTimer.current = undefined;
    setOpen(true);
    void onLoad(provider);
  }

  function choose(modelId: string): void {
    setQuery(modelId);
    onChange(modelId);
    setOpen(false);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (event.key === 'Enter' && isApi && !failed) {
      event.preventDefault();
      choose(filtered[0]?.id ?? customValue);
    }
  }

  return (
    <div
      className="model-picker"
      onBlur={() => {
        if (closeTimer.current !== undefined) window.clearTimeout(closeTimer.current);
        closeTimer.current = window.setTimeout(() => setOpen(false), 100);
      }}
    >
      <input
        value={query}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        aria-label={label}
        aria-autocomplete={isApi && !failed ? 'list' : undefined}
        aria-expanded={isApi && !failed ? open : undefined}
        onFocus={openPicker}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setQuery(next);
          onChange(next);
          if (isApi && !failed) setOpen(true);
        }}
        onKeyDown={handleKeyDown}
      />
      {isApi && <button className="button button-secondary model-picker-refresh" type="button" aria-label="刷新模型列表" disabled={disabled || state?.status === 'loading'} onMouseDown={(event) => event.preventDefault()} onClick={() => {
        setOpen(true);
        if (provider) void onLoad(provider, true);
      }}>刷新</button>}
      {failed && failureMessage && <small className="model-picker-error" role="status">{failureMessage}；可手动输入模型 ID。</small>}
      {open && isApi && !failed && <div className="model-picker-list" role="listbox" aria-label="模型列表">
        {state?.status === 'loading' && models.length === 0 && <span className="model-picker-empty">正在读取模型列表…</span>}
        {filtered.map((model) => <button
          type="button"
          role="option"
          aria-selected={model.id === value}
          className="model-picker-option"
          key={model.id}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => choose(model.id)}
        >{model.id}</button>)}
        {customValue && !exactMatch && <button
          type="button"
          role="option"
          aria-selected={false}
          className="model-picker-option model-picker-custom"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => choose(customValue)}
        >使用自定义：{customValue}</button>}
        {state?.status !== 'loading' && filtered.length === 0 && !customValue && <span className="model-picker-empty">没有匹配模型</span>}
      </div>}
    </div>
  );
}
