import { useEffect, useRef, useState } from 'react';
import type { ModelProviderView, ModelReasoning, ModelSlotEntryView } from '../api.ts';
import { modelParameterInfo, type ModelParameterName, type ProviderModelsState } from '../model-api.ts';
import { chainSummary, REASONING_OPTIONS, type SlotDef } from '../models-view.ts';
import { ModelParamField } from './ModelParamField.tsx';

type EditableField = 'temperature' | 'reasoning' | 'maxTokens';
type SlotDraft = { temperature: string; reasoning: ModelReasoning; maxTokens: string };
type Feedback = { field: EditableField; message: string; success: boolean };

function formatOptionalNumber(value: number | undefined): string {
  return value === undefined ? '' : String(value);
}

function draftFrom(entry: ModelSlotEntryView | undefined): SlotDraft {
  return {
    temperature: formatOptionalNumber(entry?.temperature),
    reasoning: entry?.reasoning ?? 'off',
    maxTokens: formatOptionalNumber(entry?.maxTokens),
  };
}

export function InlineSlotRow({ definition, chain, providers, providerModels, disabled, onEdit, onSave, onLoadModels, onOverrideChange }: {
  definition: SlotDef;
  chain: ModelSlotEntryView[];
  providers: ModelProviderView[];
  providerModels: Record<string, ProviderModelsState>;
  disabled: boolean;
  onEdit: () => void;
  onSave: (nextChain: ModelSlotEntryView[]) => Promise<string | undefined>;
  onLoadModels: (provider: ModelProviderView, refresh?: boolean) => Promise<unknown>;
  onOverrideChange: (providerId: string, modelId: string, parameter: ModelParameterName, supported: boolean) => Promise<string | undefined>;
}) {
  const first = chain[0];
  const provider = first ? providers.find((candidate) => candidate.id === first.provider) : undefined;
  const providerModelState = first ? providerModels[first.provider] : undefined;
  const providerModelStatus = providerModelState?.status;
  const serverDraft = draftFrom(first);
  const [draft, setDraft] = useState<SlotDraft>(serverDraft);
  const [dirty, setDirty] = useState<Record<EditableField, boolean>>({
    temperature: false,
    reasoning: false,
    maxTokens: false,
  });
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const [savingField, setSavingField] = useState<EditableField>();
  const [feedback, setFeedback] = useState<Feedback>();
  const feedbackTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!dirtyRef.current.temperature) setDraft((current) => ({ ...current, temperature: serverDraft.temperature }));
  }, [serverDraft.temperature]);
  useEffect(() => {
    if (!dirtyRef.current.reasoning) setDraft((current) => ({ ...current, reasoning: serverDraft.reasoning }));
  }, [serverDraft.reasoning]);
  useEffect(() => {
    if (!dirtyRef.current.maxTokens) setDraft((current) => ({ ...current, maxTokens: serverDraft.maxTokens }));
  }, [serverDraft.maxTokens]);
  useEffect(() => {
    if (provider?.kind === 'api' && first?.model && providerModelStatus === undefined) void onLoadModels(provider);
  }, [first?.model, onLoadModels, provider?.id, provider?.kind, providerModelStatus]);
  useEffect(() => () => {
    if (feedbackTimer.current !== undefined) window.clearTimeout(feedbackTimer.current);
  }, []);

  function markDirty(field: EditableField, value: boolean): void {
    const next = { ...dirtyRef.current, [field]: value };
    dirtyRef.current = next;
    setDirty(next);
  }

  function showFeedback(next: Feedback): void {
    if (feedbackTimer.current !== undefined) window.clearTimeout(feedbackTimer.current);
    setFeedback(next);
    if (next.success) {
      feedbackTimer.current = window.setTimeout(() => setFeedback(undefined), 900);
    }
  }

  function restoreField(field: EditableField): void {
    setDraft((current) => ({ ...current, [field]: serverDraft[field] }));
    markDirty(field, false);
  }

  async function saveField(field: EditableField, rawValue: string | ModelReasoning): Promise<void> {
    if (!first || disabled || savingField || !dirtyRef.current[field]) return;
    let value: number | string | undefined;
    if (field === 'temperature') {
      const text = String(rawValue).trim();
      if (text !== '') {
        const parsed = Number(text);
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2) {
          restoreField(field);
          showFeedback({ field, message: '温度需在 0 到 2 之间。', success: false });
          return;
        }
        if (Math.abs(parsed * 10 - Math.round(parsed * 10)) > 1e-8) {
          restoreField(field);
          showFeedback({ field, message: '温度步长为 0.1。', success: false });
          return;
        }
        value = parsed;
      }
    } else if (field === 'maxTokens') {
      const text = String(rawValue).trim();
      if (text !== '') {
        const parsed = Number(text);
        if (!Number.isSafeInteger(parsed) || parsed <= 0) {
          restoreField(field);
          showFeedback({ field, message: '最大长度需为正整数。', success: false });
          return;
        }
        value = parsed;
      }
    } else {
      value = rawValue as ModelReasoning;
    }

    const nextFirst: ModelSlotEntryView = field === 'temperature'
      ? { ...first, temperature: value as number | undefined }
      : field === 'maxTokens'
        ? { ...first, maxTokens: value as number | undefined }
        : { ...first, reasoning: value as ModelReasoning };
    setSavingField(field);
    if (feedbackTimer.current !== undefined) window.clearTimeout(feedbackTimer.current);
    setFeedback(undefined);
    try {
      const error = await onSave(chain.map((entry, index) => index === 0 ? nextFirst : entry));
      if (error) {
        restoreField(field);
        showFeedback({ field, message: error, success: false });
        return;
      }
      setDraft((current) => ({
        ...current,
        [field]: field === 'temperature' || field === 'maxTokens'
          ? formatOptionalNumber(value as number | undefined)
          : value as ModelReasoning,
      }));
      markDirty(field, false);
      showFeedback({ field, message: '✓', success: true });
    } finally {
      setSavingField(undefined);
    }
  }

  const editingDisabled = disabled || savingField !== undefined;
  const fallbackNote = chain.length > 1 ? <small className="slot-fallback-note">第 1 项；其余项在编辑中设置</small> : null;
  const temperatureFeedback = feedback?.field === 'temperature' ? feedback : undefined;
  const reasoningFeedback = feedback?.field === 'reasoning' ? feedback : undefined;
  const maxTokensFeedback = feedback?.field === 'maxTokens' ? feedback : undefined;
  const modelList = first ? providerModels[first.provider]?.data : undefined;
  const temperatureInfo = modelParameterInfo(provider, first?.model ?? '', 'temperature', modelList);
  const reasoningInfo = modelParameterInfo(provider, first?.model ?? '', 'reasoning', modelList);
  const maxTokensInfo = modelParameterInfo(provider, first?.model ?? '', 'maxTokens', modelList);
  const capabilityLoading = provider?.kind === 'api' && providerModelStatus !== 'ready' && providerModelStatus !== 'error';
  const parameterDisabled = editingDisabled || capabilityLoading;
  const capabilityError = providerModelState?.status === 'error' ? providerModelState.error : undefined;

  function confirmOverride(parameter: ModelParameterName, supported: boolean): Promise<string | undefined> {
    if (!provider || !first) return Promise.resolve('请先配置模型。');
    return onOverrideChange(provider.id, first.model, parameter, supported);
  }

  return (
    <tr>
      <td><strong>{definition.title}</strong><span className="slot-description">{definition.description}</span></td>
      <td>
        <button className="slot-chain-button" type="button" disabled={disabled} onClick={onEdit}>
          <span>{chainSummary(chain, providers)}</span>
          <span className="slot-chain-edit"><span aria-hidden="true">✎</span>更换</span>
        </button>
        {capabilityError && <small className="model-picker-error">能力列表读取失败：{capabilityError}；点“编辑”可重试。</small>}
      </td>
      <td>
        <ModelParamField label="温度" className="slot-inline-cell" {...temperatureInfo} disabled={parameterDisabled} allowOverride={provider?.kind === 'api' && Boolean(first?.model.trim())} onOverrideChange={(supported) => confirmOverride('temperature', supported)}>
          {(controlDisabled, title) => <input
            className="slot-inline-number mono"
            type="number"
            min={0}
            max={2}
            step={0.1}
            placeholder="默认"
            aria-label={`${definition.title}温度`}
            title={title}
            value={draft.temperature}
            disabled={controlDisabled}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setDraft((current) => ({ ...current, temperature: value }));
              markDirty('temperature', value !== serverDraft.temperature);
            }}
            onBlur={() => { void saveField('temperature', draft.temperature); }}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }}
          />}
        </ModelParamField>
        {temperatureFeedback && <small className={temperatureFeedback.success ? 'slot-inline-success' : 'slot-inline-error'}>{temperatureFeedback.message}</small>}
        {fallbackNote}
      </td>
      <td>
        <ModelParamField label="思考强度" className="slot-inline-cell" {...reasoningInfo} disabled={parameterDisabled} allowOverride={provider?.kind === 'api' && Boolean(first?.model.trim())} onOverrideChange={(supported) => confirmOverride('reasoning', supported)}>
          {(controlDisabled, title) => <select
            aria-label={`${definition.title}思考强度`}
            title={title}
            value={draft.reasoning}
            disabled={controlDisabled}
            onChange={(event) => {
              const value = event.currentTarget.value as ModelReasoning;
              setDraft((current) => ({ ...current, reasoning: value }));
              markDirty('reasoning', value !== serverDraft.reasoning);
              void saveField('reasoning', value);
            }}
          >
            {REASONING_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
          </select>}
        </ModelParamField>
        {reasoningFeedback && <small className={reasoningFeedback.success ? 'slot-inline-success' : 'slot-inline-error'}>{reasoningFeedback.message}</small>}
        {fallbackNote}
      </td>
      <td>
        <ModelParamField label="最大长度" className="slot-inline-cell" {...maxTokensInfo} disabled={parameterDisabled} allowOverride={provider?.kind === 'api' && Boolean(first?.model.trim())} onOverrideChange={(supported) => confirmOverride('maxTokens', supported)}>
          {(controlDisabled, title) => <input
            className="slot-inline-number mono"
            type="number"
            min={1}
            step={1}
            placeholder="默认"
            aria-label={`${definition.title}最大长度`}
            title={title}
            value={draft.maxTokens}
            disabled={controlDisabled}
            onChange={(event) => {
              const value = event.currentTarget.value;
              setDraft((current) => ({ ...current, maxTokens: value }));
              markDirty('maxTokens', value !== serverDraft.maxTokens);
            }}
            onBlur={() => { void saveField('maxTokens', draft.maxTokens); }}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }}
          />}
        </ModelParamField>
        {maxTokensFeedback && <small className={maxTokensFeedback.success ? 'slot-inline-success' : 'slot-inline-error'}>{maxTokensFeedback.message}</small>}
        {fallbackNote}
      </td>
      <td><button className="button button-secondary slot-inline-edit" type="button" disabled={disabled} onClick={onEdit}>编辑</button></td>
    </tr>
  );
}
