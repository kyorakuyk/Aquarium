import { useEffect, useRef, useState } from 'react';
import type { ModelProviderView, ModelReasoning, ModelSlotEntryView } from '../api.ts';
import { modelParameterInfo, type ModelParameterName, type ProviderModelsState } from '../model-api.ts';
import { chainSummary, REASONING_OPTIONS, type SlotDef } from '../models-view.ts';
import { InlineModelParamCell } from './InlineModelParamCell.tsx';

type EditableField = 'temperature' | 'reasoning' | 'maxTokens';
type SlotDraft = { temperature: string; reasoning: ModelReasoning; maxTokens: string };
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
  onOverrideChange: (providerId: string, modelId: string, parameter: ModelParameterName, supported: boolean | undefined) => Promise<string | undefined>;
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

  function markDirty(field: EditableField, value: boolean): void {
    const next = { ...dirtyRef.current, [field]: value };
    dirtyRef.current = next;
    setDirty(next);
  }

  async function saveField(field: EditableField, rawValue: string): Promise<string | undefined> {
    if (!first || disabled || savingField || !dirtyRef.current[field]) return undefined;
    let value: number | string | undefined;
    if (field === 'temperature') {
      const text = rawValue.trim();
      if (text !== '') {
        const parsed = Number(text);
        if (!Number.isFinite(parsed) || parsed < 0 || parsed > 2) {
          return '温度需在 0 到 2 之间。';
        }
        if (Math.abs(parsed * 10 - Math.round(parsed * 10)) > 1e-8) {
          return '温度步长为 0.1。';
        }
        value = parsed;
      }
    } else if (field === 'maxTokens') {
      const text = rawValue.trim();
      if (text !== '') {
        const parsed = Number(text);
        if (!Number.isSafeInteger(parsed) || parsed <= 0) {
          return '最大长度需为正整数。';
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
    try {
      const error = await onSave(chain.map((entry, index) => index === 0 ? nextFirst : entry));
      if (error) return error;
      setDraft((current) => ({
        ...current,
        [field]: field === 'temperature' || field === 'maxTokens'
          ? formatOptionalNumber(value as number | undefined)
          : value as ModelReasoning,
      }));
      markDirty(field, false);
      return undefined;
    } finally {
      setSavingField(undefined);
    }
  }

  const editingDisabled = disabled || savingField !== undefined;
  const modelList = first ? providerModels[first.provider]?.data : undefined;
  const temperatureInfo = modelParameterInfo(provider, first?.model ?? '', 'temperature', modelList);
  const reasoningInfo = modelParameterInfo(provider, first?.model ?? '', 'reasoning', modelList);
  const maxTokensInfo = modelParameterInfo(provider, first?.model ?? '', 'maxTokens', modelList);
  const capabilityLoading = provider?.kind === 'api' && providerModelStatus !== 'ready' && providerModelStatus !== 'error';
  const parameterDisabled = editingDisabled || capabilityLoading || !first;

  function confirmOverride(parameter: ModelParameterName, supported: boolean | undefined): Promise<string | undefined> {
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
      </td>
      <td><InlineModelParamCell
        label="温度"
        value={draft.temperature}
        {...temperatureInfo}
        disabled={parameterDisabled}
        allowOverride={provider?.kind === 'api' && Boolean(first?.model.trim())}
        onCommit={(value) => saveField('temperature', value)}
        onOverrideChange={(supported) => confirmOverride('temperature', supported)}
      >
        {(value, onChange, controlDisabled) => <input type="number" min={0} max={2} step={0.1} placeholder="默认" value={value} disabled={controlDisabled} onChange={(event) => {
          const next = event.currentTarget.value;
          onChange(next);
          setDraft((current) => ({ ...current, temperature: next }));
          markDirty('temperature', next !== serverDraft.temperature);
        }} />}
      </InlineModelParamCell></td>
      <td><InlineModelParamCell
        label="思考强度"
        value={draft.reasoning}
        {...reasoningInfo}
        disabled={parameterDisabled}
        allowOverride={provider?.kind === 'api' && Boolean(first?.model.trim())}
        onCommit={(value) => saveField('reasoning', value)}
        onOverrideChange={(supported) => confirmOverride('reasoning', supported)}
      >
        {(value, onChange, controlDisabled) => <select value={value} disabled={controlDisabled} onChange={(event) => {
          const next = event.currentTarget.value;
          onChange(next);
          setDraft((current) => ({ ...current, reasoning: next as ModelReasoning }));
          markDirty('reasoning', next !== serverDraft.reasoning);
        }}>{REASONING_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select>}
      </InlineModelParamCell></td>
      <td><InlineModelParamCell
        label="最大长度"
        value={draft.maxTokens}
        {...maxTokensInfo}
        disabled={parameterDisabled}
        allowOverride={provider?.kind === 'api' && Boolean(first?.model.trim())}
        onCommit={(value) => saveField('maxTokens', value)}
        onOverrideChange={(supported) => confirmOverride('maxTokens', supported)}
      >
        {(value, onChange, controlDisabled) => <input type="number" min={1} step={1} placeholder="默认" value={value} disabled={controlDisabled} onChange={(event) => {
          const next = event.currentTarget.value;
          onChange(next);
          setDraft((current) => ({ ...current, maxTokens: next }));
          markDirty('maxTokens', next !== serverDraft.maxTokens);
        }} />}
      </InlineModelParamCell></td>
      <td><button className="button button-secondary slot-inline-edit" type="button" disabled={disabled} onClick={onEdit}>编辑</button></td>
    </tr>
  );
}
