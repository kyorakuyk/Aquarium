import { useEffect, useRef, useState, type DragEvent } from 'react';
import { apiRequest, patch, post, type ModelProviderView, type ModelSlotEntryView } from '../api.ts';
import { reasoningFieldOptions, type SlotDef } from '../models-view.ts';
import type { ModelParameterName, ProviderModelsState } from '../model-api.ts';
import { SlotDialogRowCard, type SlotDialogRow } from './SlotDialogRowCard.tsx';

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

export function SlotDialog({ definition, chain, providers, providerModels, pageBusy, onLoadModels, onOverrideChange, onClose, onSaved }: {
  definition: SlotDef;
  chain: ModelSlotEntryView[];
  providers: ModelProviderView[];
  providerModels: Record<string, ProviderModelsState>;
  pageBusy: boolean;
  onLoadModels: (provider: ModelProviderView, refresh?: boolean) => Promise<unknown>;
  onOverrideChange: (providerId: string, modelId: string, parameter: ModelParameterName, supported: boolean | undefined) => Promise<string | undefined>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { ref, close } = useDialog(onClose);
  const nextKey = useRef(0);
  const draggedRowKey = useRef<number | undefined>(undefined);
  const [activeDragKey, setActiveDragKey] = useState<number | undefined>(undefined);
  const [dropTargetKey, setDropTargetKey] = useState<number | undefined>(undefined);
  const toRow = (entry: ModelSlotEntryView): SlotDialogRow => ({
    key: nextKey.current++,
    provider: entry.provider,
    model: entry.model,
    temperature: entry.temperature === undefined ? '' : String(entry.temperature),
    maxTokens: entry.maxTokens === undefined ? '' : String(entry.maxTokens),
    reasoning: entry.reasoning ?? 'off',
  });
  const [rows, setRows] = useState<SlotDialogRow[]>(() => chain.map(toRow));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialogBusy = busy || pageBusy;

  function change(key: number, patch: Partial<Omit<SlotDialogRow, 'key'>>) {
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

  function moveToPosition(sourceKey: number, targetKey: number): void {
    if (sourceKey === targetKey) return;
    setRows((current) => {
      const sourceIndex = current.findIndex((row) => row.key === sourceKey);
      const targetIndex = current.findIndex((row) => row.key === targetKey);
      if (sourceIndex < 0 || targetIndex < 0) return current;
      const next = [...current];
      const [source] = next.splice(sourceIndex, 1);
      if (!source) return current;
      next.splice(targetIndex, 0, source);
      return next;
    });
  }

  function startDrag(key: number, event: DragEvent<HTMLButtonElement>): void {
    if (dialogBusy) return;
    draggedRowKey.current = key;
    setActiveDragKey(key);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(key));
  }

  function dragOver(key: number, event: DragEvent<HTMLLIElement>): void {
    if (draggedRowKey.current === undefined || draggedRowKey.current === key) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    if (dropTargetKey !== key) setDropTargetKey(key);
  }

  function dropOn(key: number, event: DragEvent<HTMLLIElement>): void {
    event.preventDefault();
    const sourceKey = draggedRowKey.current;
    if (sourceKey !== undefined) moveToPosition(sourceKey, key);
    endDrag();
  }

  function endDrag(): void {
    draggedRowKey.current = undefined;
    setActiveDragKey(undefined);
    setDropTargetKey(undefined);
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
      if (temperature !== undefined && (!Number.isFinite(temperature) || temperature < 0 || temperature > 2 || Math.abs(temperature * 10 - Math.round(temperature * 10)) > 1e-8)) {
        setError('温度需在 0 到 2 之间，步长为 0.1。');
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
    <dialog className="model-dialog slot-dialog" ref={ref} aria-labelledby="slot-dialog-title" onClose={close}>
      <header className="slot-dialog-header">
        <div>
          <h3 id="slot-dialog-title">{definition.title}</h3>
          <p>{definition.description} · 按顺序尝试，前一项失败才用下一项</p>
        </div>
        <button className="slot-dialog-close" type="button" aria-label="关闭" title="关闭" onClick={close}>×</button>
      </header>
      <div className="slot-dialog-body">
        {error && <p className="notice notice-warn" role="alert">{error}</p>}
        <ol className="slot-editor">
          {rows.map((row, index) => <SlotDialogRowCard
            key={row.key}
            definition={definition}
            row={row}
            index={index}
            rowCount={rows.length}
            providers={providers}
            providerModels={providerModels}
            disabled={dialogBusy}
            dragging={activeDragKey === row.key}
            dropTarget={dropTargetKey === row.key}
            onChange={(patch) => change(row.key, patch)}
            onMove={(direction) => move(index, direction)}
            onDelete={() => setRows((current) => current.filter((item) => item.key !== row.key))}
            onLoadModels={onLoadModels}
            onOverrideChange={onOverrideChange}
            onDragStart={(event) => startDrag(row.key, event)}
            onDragOver={(event) => dragOver(row.key, event)}
            onDrop={(event) => dropOn(row.key, event)}
            onDragEnd={endDrag}
          />)}
        </ol>
        <button className="slot-add" type="button" disabled={dialogBusy || providers.length === 0 || rows.length >= 8} onClick={addRow}>＋ 添加降级项</button>
        <p className="slot-dialog-help">参数旁的 ? 表示接入没有声明是否支持，可能被忽略；点开参数即可标记。拖动左侧圆点调整顺序。</p>
      </div>
      <footer className="slot-dialog-footer">
        <button className="button button-secondary" type="button" disabled={dialogBusy} onClick={close}>取消</button>
        <button className="button button-primary" type="button" disabled={dialogBusy} onClick={() => void save()}>{dialogBusy ? '保存中…' : '保存'}</button>
      </footer>
    </dialog>
  );
}
