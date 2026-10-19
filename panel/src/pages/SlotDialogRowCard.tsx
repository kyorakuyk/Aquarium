import { useState, type DragEvent as ReactDragEvent } from 'react';
import type { ModelProviderView, ModelReasoning } from '../api.ts';
import { modelParameterInfo, type ModelParameterName, type ProviderModelsState } from '../model-api.ts';
import { REASONING_OPTIONS, type SlotDef } from '../models-view.ts';
import { InlineModelParamCell } from './InlineModelParamCell.tsx';
import { ModelPicker } from './ModelPicker.tsx';
import { MaxTokensParameterControls, ReasoningParameterControls, TemperatureParameterControls } from './SlotParameterControls.tsx';

export interface SlotDialogRow {
  key: number;
  provider: string;
  model: string;
  temperature: string;
  maxTokens: string;
  reasoning: ModelReasoning;
}

type SlotDialogRowPatch = Partial<Omit<SlotDialogRow, 'key'>>;

export function SlotDialogRowCard({
  definition,
  row,
  index,
  rowCount,
  providers,
  providerModels,
  disabled,
  dragging,
  dropTarget,
  onChange,
  onMove,
  onDelete,
  onLoadModels,
  onOverrideChange,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  definition: SlotDef;
  row: SlotDialogRow;
  index: number;
  rowCount: number;
  providers: ModelProviderView[];
  providerModels: Record<string, ProviderModelsState>;
  disabled: boolean;
  dragging: boolean;
  dropTarget: boolean;
  onChange: (patch: SlotDialogRowPatch) => void;
  onMove: (direction: -1 | 1) => void;
  onDelete: () => void;
  onLoadModels: (provider: ModelProviderView, refresh?: boolean) => Promise<unknown>;
  onOverrideChange: (providerId: string, modelId: string, parameter: ModelParameterName, supported: boolean | undefined) => Promise<string | undefined>;
  onDragStart: (event: ReactDragEvent<HTMLButtonElement>) => void;
  onDragOver: (event: ReactDragEvent<HTMLLIElement>) => void;
  onDrop: (event: ReactDragEvent<HTMLLIElement>) => void;
  onDragEnd: () => void;
}) {
  const [temperatureFallback, setTemperatureFallback] = useState(row.temperature || '0.9');
  const [maxTokensFallback, setMaxTokensFallback] = useState(row.maxTokens || '800');
  const provider = providers.find((candidate) => candidate.id === row.provider);
  const modelState = providerModels[row.provider];
  const modelList = modelState?.data;
  const capabilitiesLoading = provider?.kind === 'api' && modelState?.status !== 'ready' && modelState?.status !== 'error';
  const parameterDisabled = disabled || capabilitiesLoading;
  const temperatureInfo = modelParameterInfo(provider, row.model, 'temperature', modelList);
  const reasoningInfo = modelParameterInfo(provider, row.model, 'reasoning', modelList);
  const maxTokensInfo = modelParameterInfo(provider, row.model, 'maxTokens', modelList);
  const reasoningLabel = REASONING_OPTIONS.find((option) => option.value === row.reasoning)?.label ?? '关';

  function override(parameter: ModelParameterName, supported: boolean | undefined): Promise<string | undefined> {
    if (!provider) return Promise.resolve('请先选择模型接入。');
    return onOverrideChange(provider.id, row.model, parameter, supported);
  }

  function temperatureError(value: string): string | undefined {
    if (!value.trim()) return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2) return '温度需在 0 到 2 之间。';
    if (Math.abs(parsed * 10 - Math.round(parsed * 10)) > 1e-8) return '温度步长为 0.1。';
    return undefined;
  }

  function maxTokensError(value: string): string | undefined {
    if (!value.trim()) return undefined;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? undefined : '最大输出需为正整数。';
  }

  function onTemperatureChange(value: string, update: (value: string) => void): void {
    if (value.trim()) setTemperatureFallback(value);
    update(value);
    onChange({ temperature: value });
  }

  function onMaxTokensChange(value: string, update: (value: string) => void): void {
    if (value.trim()) setMaxTokensFallback(value);
    update(value);
    onChange({ maxTokens: value });
  }

  return (
    <li
      className={`slot-editor-card${dragging ? ' is-dragging' : ''}${dropTarget ? ' is-drop-target' : ''}`}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className="slot-order-rail">
        <span className={`slot-index mono${index === 0 ? ' is-first' : ''}`}>{index + 1}</span>
        <button
          className="slot-drag-handle"
          type="button"
          draggable={!disabled}
          disabled={disabled}
          aria-label={`拖动第 ${index + 1} 项；也可用更多操作调整顺序`}
          title="拖动排序；键盘操作请用更多操作菜单"
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        >
          <svg width="14" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="9" cy="5" r="1.6" /><circle cx="15" cy="5" r="1.6" />
            <circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" />
            <circle cx="9" cy="19" r="1.6" /><circle cx="15" cy="19" r="1.6" />
          </svg>
        </button>
      </div>
      <div className="slot-card-content">
        <div className="slot-card-main-row">
          <select
            className="slot-provider-select"
            aria-label={`第 ${index + 1} 项接入`}
            value={row.provider}
            disabled={disabled}
            onChange={(event) => onChange({ provider: event.currentTarget.value, model: '' })}
          >
            {providers.map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.label}</option>)}
          </select>
          <ModelPicker
            provider={provider}
            value={row.model}
            label={`${definition.title}第 ${index + 1} 项模型名`}
            state={modelState}
            disabled={disabled || !provider}
            onLoad={onLoadModels}
            onChange={(model) => onChange({ model })}
          />
          <details className="slot-row-menu">
            <summary aria-label={`第 ${index + 1} 项更多操作`} title="更多操作">⋯</summary>
            <div className="slot-row-menu-list" role="group" aria-label={`第 ${index + 1} 项操作`}>
              <button type="button" disabled={disabled || index === 0} onClick={(event) => { onMove(-1); event.currentTarget.closest('details')?.removeAttribute('open'); }}>上移</button>
              <button type="button" disabled={disabled || index === rowCount - 1} onClick={(event) => { onMove(1); event.currentTarget.closest('details')?.removeAttribute('open'); }}>下移</button>
              <button type="button" disabled={disabled} onClick={(event) => { onDelete(); event.currentTarget.closest('details')?.removeAttribute('open'); }}>删除</button>
            </div>
          </details>
        </div>
        <div className="slot-parameter-pills">
          <InlineModelParamCell
            variant="pill"
            label="温度"
            value={row.temperature}
            displayValue={row.temperature || '默认'}
            {...temperatureInfo}
            disabled={parameterDisabled}
            allowOverride={provider?.kind === 'api' && Boolean(row.model.trim())}
            onCommit={async (value) => temperatureError(value)}
            onOverrideChange={(supported) => override('temperature', supported)}
          >
            {(value, update, controlDisabled) => <TemperatureParameterControls
              value={value}
              fallback={temperatureFallback}
              disabled={controlDisabled}
              onChange={(next) => onTemperatureChange(next, update)}
            />}
          </InlineModelParamCell>
          <InlineModelParamCell
            variant="pill"
            label="思考"
            value={row.reasoning}
            displayValue={reasoningLabel}
            {...reasoningInfo}
            disabled={parameterDisabled}
            allowOverride={provider?.kind === 'api' && Boolean(row.model.trim())}
            onCommit={async () => undefined}
            onOverrideChange={(supported) => override('reasoning', supported)}
          >
            {(value, update, controlDisabled) => <ReasoningParameterControls
              value={value as ModelReasoning}
              disabled={controlDisabled}
              onChange={(next) => { update(next); onChange({ reasoning: next }); }}
            />}
          </InlineModelParamCell>
          <InlineModelParamCell
            variant="pill"
            label="最大输出"
            value={row.maxTokens}
            displayValue={row.maxTokens ? `${row.maxTokens} token` : '默认'}
            {...maxTokensInfo}
            disabled={parameterDisabled}
            allowOverride={provider?.kind === 'api' && Boolean(row.model.trim())}
            onCommit={async (value) => maxTokensError(value)}
            onOverrideChange={(supported) => override('maxTokens', supported)}
          >
            {(value, update, controlDisabled) => <MaxTokensParameterControls
              value={value}
              fallback={maxTokensFallback}
              disabled={controlDisabled}
              onChange={(next) => onMaxTokensChange(next, update)}
            />}
          </InlineModelParamCell>
        </div>
      </div>
    </li>
  );
}
