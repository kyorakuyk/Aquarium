import { useEffect, useRef, useState } from 'react';
import { apiRequest, patch, post, type ModelProviderView, type ModelReasoning, type ModelSlotEntryView } from '../api.ts';
import { REASONING_OPTIONS, reasoningFieldOptions, type SlotDef } from '../models-view.ts';
import { modelParameterInfo, type ModelParameterName, type ProviderModelsState } from '../model-api.ts';
import { ModelParamField } from './ModelParamField.tsx';
import { ModelPicker } from './ModelPicker.tsx';

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : '操作失败';
}

function useDialog(onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return { ref, close: onClose };
}

export function ProviderDialog({
  mode,
  kind,
  provider,
  onClose,
  onSaved,
}: {
  mode: 'create' | 'edit';
  kind: 'api' | 'cli';
  provider?: ModelProviderView;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { ref, close } = useDialog(onClose);
  const [id, setId] = useState(provider?.id ?? '');
  const [label, setLabel] = useState(provider?.label ?? '');
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '');
  const [apiKeyEnv, setApiKeyEnv] = useState(provider?.apiKeyEnv ?? 'DEEPSEEK_API_KEY');
  const [reasoningField, setReasoningField] = useState(provider?.reasoningField ?? 'reasoning_effort');
  const [command, setCommand] = useState(provider?.command ?? '');
  const [argsText, setArgsText] = useState((provider?.args ?? []).join('\n'));
  const [prewarm, setPrewarm] = useState(provider?.prewarm ?? false);
  const [timeoutSec, setTimeoutSec] = useState(String(provider?.timeoutSec ?? 120));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    if (busy) return;
    const trimmedLabel = label.trim();
    const body = kind === 'api'
      ? {
        ...(trimmedLabel ? { label: trimmedLabel } : mode === 'edit' ? { label: null } : {}),
        baseUrl: baseUrl.trim(),
        apiKeyEnv: apiKeyEnv.trim(),
        reasoningField: reasoningField.trim() || 'reasoning_effort',
      }
      : {
        ...(trimmedLabel ? { label: trimmedLabel } : mode === 'edit' ? { label: null } : {}),
        command: command.trim(),
        args: argsText.split('\n').map((line) => line.trim()).filter(Boolean),
        prewarm,
        timeoutSec: Number(timeoutSec),
      };
    setBusy(true);
    setError('');
    try {
      if (mode === 'create') {
        await post('/api/providers', { id: id.trim(), provider: { kind, ...body } });
      } else if (provider) {
        await patch(`/api/providers/${encodeURIComponent(provider.id)}`, body);
      }
      onSaved();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!provider || busy) return;
    if (!window.confirm(`删除接入“${provider.label}”？`)) return;
    setBusy(true);
    setError('');
    try {
      await apiRequest(`/api/providers/${encodeURIComponent(provider.id)}`, { method: 'DELETE' });
      onSaved();
    } catch (reason) {
      const message = errorMessage(reason);
      setError(message.includes('referenced') ? '该接入仍被用途引用，请先在用途表中移除它。' : message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog className="model-dialog" ref={ref} aria-labelledby="provider-dialog-title" onClose={close}>
      <div className="model-dialog-heading">
        <div><span className="eyebrow">{kind === 'api' ? 'API 接入' : 'CLI 接入'}</span><h3 id="provider-dialog-title">{mode === 'create' ? '添加接入' : '编辑接入'}</h3></div>
        <button className="text-button" type="button" onClick={close}>关闭</button>
      </div>
      {error && <p className="notice notice-warn" role="alert">{error}</p>}
      <div className="model-form-grid">
        {mode === 'create' && <label><span className="field-label">标识</span><input value={id} placeholder="例如 deepseek" autoComplete="off" disabled={busy} onChange={(event) => setId(event.currentTarget.value)} /></label>}
        <label><span className="field-label">显示名</span><input value={label} placeholder="留空则使用标识" disabled={busy} onChange={(event) => setLabel(event.currentTarget.value)} /></label>
        {kind === 'api' ? <>
          <label className="model-form-wide"><span className="field-label">Base URL</span><input value={baseUrl} placeholder="https://api.example.com/v1" autoComplete="off" disabled={busy} onChange={(event) => setBaseUrl(event.currentTarget.value)} /></label>
          <label><span className="field-label">密钥变量名</span><input value={apiKeyEnv} autoComplete="off" disabled={busy} onChange={(event) => setApiKeyEnv(event.currentTarget.value)} /></label>
          <label><span className="field-label">思考强度字段</span><select value={reasoningField} disabled={busy} onChange={(event) => setReasoningField(event.currentTarget.value)}>
            {reasoningFieldOptions(reasoningField).map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
          </select></label>
        </> : <>
          <label className="model-form-wide"><span className="field-label">命令</span><input value={command} placeholder="例如 claude" autoComplete="off" disabled={busy} onChange={(event) => setCommand(event.currentTarget.value)} /></label>
          <label className="model-form-wide"><span className="field-label">参数（每行一个）</span><textarea value={argsText} rows={4} spellCheck={false} disabled={busy} onChange={(event) => setArgsText(event.currentTarget.value)} /></label>
          <label><span className="field-label">超时（秒）</span><input type="number" min={1} max={3600} value={timeoutSec} disabled={busy} onChange={(event) => setTimeoutSec(event.currentTarget.value)} /></label>
          <label className="model-checkbox"><input type="checkbox" checked={prewarm} disabled={busy} onChange={(event) => setPrewarm(event.currentTarget.checked)} /><span>常驻后台（预热一个空闲进程）</span></label>
        </>}
      </div>
      <div className="model-dialog-footer">
        {mode === 'edit' && <button className="text-button model-delete" type="button" disabled={busy} onClick={() => void remove()}>删除接入</button>}
        <div><button className="button button-secondary" type="button" disabled={busy} onClick={close}>取消</button><button className="button button-primary" type="button" disabled={busy} onClick={() => void save()}>{busy ? '保存中…' : '保存'}</button></div>
      </div>
    </dialog>
  );
}

export function KeyDialog({ provider, onClose, onSaved }: {
  provider: ModelProviderView;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { ref, close } = useDialog(onClose);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    if (busy || !key.trim()) return;
    setBusy(true);
    setError('');
    try {
      await apiRequest(`/api/providers/${encodeURIComponent(provider.id)}/key`, {
        method: 'PUT',
        body: JSON.stringify({ key: key.trim() }),
      });
      setKey('');
      onSaved();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog className="model-dialog model-dialog-compact" ref={ref} aria-labelledby="key-dialog-title" onClose={close}>
      <div className="model-dialog-heading"><div><span className="eyebrow">仅本机</span><h3 id="key-dialog-title">设置密钥 · {provider.label}</h3></div><button className="text-button" type="button" onClick={close}>关闭</button></div>
      <p className="model-help">密钥只写入仓库根目录的 .env；界面之后只显示后四位。</p>
      {error && <p className="notice notice-warn" role="alert">{error}</p>}
      <label><span className="field-label">API Key</span><input type="password" value={key} autoComplete="new-password" spellCheck={false} disabled={busy} onChange={(event) => setKey(event.currentTarget.value)} /></label>
      <div className="model-dialog-footer"><span /><div><button className="button button-secondary" type="button" disabled={busy} onClick={close}>取消</button><button className="button button-primary" type="button" disabled={busy || !key.trim()} onClick={() => void save()}>{busy ? '保存中…' : '保存密钥'}</button></div></div>
    </dialog>
  );
}

interface SlotRow {
  key: number;
  provider: string;
  model: string;
  temperature: string;
  maxTokens: string;
  reasoning: ModelReasoning;
}

export function SlotDialog({ definition, chain, providers, providerModels, pageBusy, onLoadModels, onOverrideChange, onClose, onSaved }: {
  definition: SlotDef;
  chain: ModelSlotEntryView[];
  providers: ModelProviderView[];
  providerModels: Record<string, ProviderModelsState>;
  pageBusy: boolean;
  onLoadModels: (provider: ModelProviderView, refresh?: boolean) => Promise<unknown>;
  onOverrideChange: (providerId: string, modelId: string, parameter: ModelParameterName, supported: boolean) => Promise<string | undefined>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { ref, close } = useDialog(onClose);
  const nextKey = useRef(0);
  const toRow = (entry: ModelSlotEntryView): SlotRow => ({
    key: nextKey.current++,
    provider: entry.provider,
    model: entry.model,
    temperature: entry.temperature === undefined ? '' : String(entry.temperature),
    maxTokens: entry.maxTokens === undefined ? '' : String(entry.maxTokens),
    reasoning: entry.reasoning ?? 'off',
  });
  const [rows, setRows] = useState<SlotRow[]>(() => chain.map(toRow));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialogBusy = busy || pageBusy;

  function change(key: number, patch: Partial<Omit<SlotRow, 'key'>>) {
    setRows((current) => current.map((row) => row.key === key ? { ...row, ...patch } : row));
  }

  function addRow() {
    const first = providers[0]?.id ?? '';
    setRows((current) => [...current, { key: nextKey.current++, provider: first, model: '', temperature: '', maxTokens: '', reasoning: 'off' }]);
  }

  function move(index: number, direction: -1 | 1) {
    setRows((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      const item = next[index];
      const other = next[target];
      if (!item || !other) return current;
      next[index] = other;
      next[target] = item;
      return next;
    });
  }

  async function save() {
    if (rows.length === 0) {
      setError('至少保留一项降级项。');
      return;
    }
    if (dialogBusy) return;
    const chainBody: ModelSlotEntryView[] = [];
    for (const row of rows) {
      const temperature = row.temperature.trim() === '' ? undefined : Number(row.temperature);
      const maxTokens = row.maxTokens.trim() === '' ? undefined : Number(row.maxTokens);
      if (!row.provider || !row.model.trim()) {
        setError('每一项都需要选择接入并填写模型名。');
        return;
      }
      if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
        setError('温度需在 0 到 2 之间。');
        return;
      }
      if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens <= 0)) {
        setError('最大长度需为正整数。');
        return;
      }
      chainBody.push({
        provider: row.provider,
        model: row.model.trim(),
        ...(temperature !== undefined ? { temperature } : {}),
        ...(maxTokens !== undefined ? { maxTokens } : {}),
        reasoning: row.reasoning,
      });
    }
    setBusy(true);
    setError('');
    try {
      await apiRequest(`/api/slots/${encodeURIComponent(definition.slot)}`, {
        method: 'PUT',
        body: JSON.stringify({ chain: chainBody }),
      });
      onSaved();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog className="model-dialog model-dialog-wide" ref={ref} aria-labelledby="slot-dialog-title" onClose={close}>
      <div className="model-dialog-heading"><div><span className="eyebrow">用途</span><h3 id="slot-dialog-title">{definition.title}</h3></div><button className="text-button" type="button" onClick={close}>关闭</button></div>
      <p className="model-help">{definition.description}；按顺序降级，前一项失败才尝试下一项。</p>
      {error && <p className="notice notice-warn" role="alert">{error}</p>}
      <div className="slot-editor">
        {rows.map((row, index) => {
          const provider = providers.find((candidate) => candidate.id === row.provider);
          const modelList = providerModels[row.provider]?.data;
          const modelListStatus = providerModels[row.provider]?.status;
          const capabilitiesLoading = provider?.kind === 'api' && modelListStatus !== 'ready' && modelListStatus !== 'error';
          const parameterDisabled = dialogBusy || capabilitiesLoading;
          const temperatureInfo = modelParameterInfo(provider, row.model, 'temperature', modelList);
          const reasoningInfo = modelParameterInfo(provider, row.model, 'reasoning', modelList);
          const maxTokensInfo = modelParameterInfo(provider, row.model, 'maxTokens', modelList);
          const confirmOverride = (parameter: ModelParameterName, supported: boolean) => provider
            ? onOverrideChange(provider.id, row.model, parameter, supported)
            : Promise.resolve('请先选择模型接入。');
          return <div className="slot-editor-row" key={row.key}>
            <span className="slot-index mono">{index + 1}</span>
            <label><span className="field-label">接入</span><select value={row.provider} disabled={dialogBusy} onChange={(event) => change(row.key, { provider: event.currentTarget.value })}>
              {providers.map((candidate) => <option value={candidate.id} key={candidate.id}>{candidate.label}</option>)}
            </select></label>
            <div className="slot-editor-model">
              <span className="field-label">模型名</span>
              <ModelPicker
                provider={provider}
                value={row.model}
                label={`${definition.title}第 ${index + 1} 项模型名`}
                state={providerModels[row.provider]}
                disabled={dialogBusy}
                onLoad={onLoadModels}
                onChange={(model) => change(row.key, { model })}
              />
            </div>
            <ModelParamField label="温度" className="slot-editor-param" {...temperatureInfo} disabled={parameterDisabled} allowOverride={provider?.kind === 'api' && Boolean(row.model.trim())} onOverrideChange={(supported) => confirmOverride('temperature', supported)}>
              {(controlDisabled, title) => <input className="mono" type="number" min={0} max={2} step={0.1} placeholder="默认" value={row.temperature} title={title} disabled={controlDisabled} onChange={(event) => change(row.key, { temperature: event.currentTarget.value })} />}
            </ModelParamField>
            <ModelParamField label="思考强度" className="slot-editor-param" {...reasoningInfo} disabled={parameterDisabled} allowOverride={provider?.kind === 'api' && Boolean(row.model.trim())} onOverrideChange={(supported) => confirmOverride('reasoning', supported)}>
              {(controlDisabled, title) => <select value={row.reasoning} title={title} disabled={controlDisabled} onChange={(event) => change(row.key, { reasoning: event.currentTarget.value as ModelReasoning })}>
                {REASONING_OPTIONS.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
              </select>}
            </ModelParamField>
            <ModelParamField label="最大长度" className="slot-editor-param" {...maxTokensInfo} disabled={parameterDisabled} allowOverride={provider?.kind === 'api' && Boolean(row.model.trim())} onOverrideChange={(supported) => confirmOverride('maxTokens', supported)}>
              {(controlDisabled, title) => <input className="mono" type="number" min={1} step={1} placeholder="默认" value={row.maxTokens} title={title} disabled={controlDisabled} onChange={(event) => change(row.key, { maxTokens: event.currentTarget.value })} />}
            </ModelParamField>
            <div className="slot-row-actions">
              <button className="text-button" type="button" aria-label={`上移第 ${index + 1} 项`} disabled={dialogBusy || index === 0} onClick={() => move(index, -1)}>上移</button>
              <button className="text-button" type="button" aria-label={`下移第 ${index + 1} 项`} disabled={dialogBusy || index === rows.length - 1} onClick={() => move(index, 1)}>下移</button>
              <button className="text-button" type="button" aria-label={`删除第 ${index + 1} 项`} disabled={dialogBusy} onClick={() => setRows((current) => current.filter((item) => item.key !== row.key))}>删除</button>
            </div>
          </div>;
        })}
      </div>
      <button className="text-button slot-add" type="button" disabled={dialogBusy || providers.length === 0 || rows.length >= 8} onClick={addRow}>添加降级项</button>
      <div className="model-dialog-footer"><span /><div><button className="button button-secondary" type="button" disabled={dialogBusy} onClick={close}>取消</button><button className="button button-primary" type="button" disabled={dialogBusy} onClick={() => void save()}>{dialogBusy ? '保存中…' : '保存'}</button></div></div>
    </dialog>
  );
}
