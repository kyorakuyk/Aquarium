import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest, patch, post, type ModelProviderView, type ModelsView } from '../api.ts';
import { MODEL_SLOT_DEFS, providerMeta, providerStatus } from '../models-view.ts';
import { KeyDialog, ProviderDialog, SlotDialog } from './ModelDialogs.tsx';
import { InlineSlotRow } from './InlineSlotRow.tsx';

interface TestState {
  busy?: boolean;
  ok?: boolean;
  latencyMs?: number;
  error?: string;
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : '操作失败';
}

function ProviderCard({
  provider,
  busy,
  test,
  onEdit,
  onKey,
  onTest,
  onTogglePrewarm,
  onRestart,
}: {
  provider: ModelProviderView;
  busy: boolean;
  test?: TestState;
  onEdit: () => void;
  onKey: () => void;
  onTest: () => void;
  onTogglePrewarm: () => void;
  onRestart: () => void;
}) {
  const status = providerStatus(provider);
  return (
    <article className="provider-card">
      <div className="provider-card-main">
        <div className="provider-title-line">
          <h3>{provider.label}</h3>
          <span className={`kind-badge kind-${provider.kind}`}>{provider.kind.toUpperCase()}</span>
        </div>
        <p className="provider-meta mono" title={providerMeta(provider)}>{providerMeta(provider)}</p>
        <p className="provider-status">
          <span className={`status-dot status-${status.tone}`} aria-hidden="true" />
          <span>{status.text}</span>
          {test?.busy && <span className="muted"> · 测试中…</span>}
          {test?.ok && <span className="muted"> · 延迟 {test.latencyMs ?? 0} ms</span>}
          {test?.error && <span className="provider-test-error"> · {test.error}</span>}
        </p>
      </div>
      <div className="provider-actions">
        {provider.kind === 'api' ? <>
          <button className="button button-secondary" type="button" disabled={busy || !provider.keyStatus.set || test?.busy} onClick={onTest}>{test?.busy ? '测试中…' : '测试连接'}</button>
          <button className="button button-secondary" type="button" disabled={busy} onClick={onKey}>{provider.keyStatus.set ? '更换密钥' : '设置密钥'}</button>
        </> : <>
          <span className="provider-prewarm-label">常驻后台</span>
          <button className={`switch provider-prewarm ${provider.prewarm ? 'is-on' : ''}`} type="button" role="switch" aria-checked={provider.prewarm} aria-label="常驻后台" disabled={busy} onClick={onTogglePrewarm}><span /></button>
          <button className="button button-secondary" type="button" disabled={busy || !provider.prewarm} onClick={onRestart}>重启</button>
        </>}
        <button className="button button-secondary" type="button" disabled={busy} onClick={onEdit}>编辑</button>
      </div>
    </article>
  );
}

export function ModelsPage() {
  const [view, setView] = useState<ModelsView>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const slotSaveInFlight = useRef(false);
  const [providerDialog, setProviderDialog] = useState<{ mode: 'create' | 'edit'; kind: 'api' | 'cli'; provider?: ModelProviderView }>();
  const [keyTarget, setKeyTarget] = useState<ModelProviderView>();
  const [slotDialog, setSlotDialog] = useState<string>();

  const load = useCallback(async (): Promise<boolean> => {
    try {
      setView(await apiRequest<ModelsView>('/api/models'));
      setError('');
      return true;
    } catch (reason) {
      setError(errorMessage(reason));
      return false;
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { void load(); }, 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

  async function mutate(task: () => Promise<unknown>): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setError('');
    try {
      await task();
      return await load();
    } catch (reason) {
      setError(errorMessage(reason));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function saveSlotChain(slot: string, chain: ModelsView['slots'][string]): Promise<string | undefined> {
    if (busy || slotSaveInFlight.current) return '另一个设置正在保存。';
    slotSaveInFlight.current = true;
    setBusy(true);
    try {
      const saved = await patch<{ chain: ModelsView['slots'][string] }>(`/api/slots/${encodeURIComponent(slot)}`, { chain });
      setView((current) => current ? {
        ...current,
        slots: { ...current.slots, [slot]: saved.chain },
      } : current);
      await load();
      return undefined;
    } catch (reason) {
      return errorMessage(reason);
    } finally {
      slotSaveInFlight.current = false;
      setBusy(false);
    }
  }

  async function testProvider(provider: ModelProviderView) {
    setTests((current) => ({ ...current, [provider.id]: { busy: true } }));
    try {
      const result = await post(`/api/providers/${encodeURIComponent(provider.id)}/test`, {}) as { ok: boolean; latencyMs: number; error?: string };
      setTests((current) => ({ ...current, [provider.id]: { ok: result.ok, latencyMs: result.latencyMs, ...(result.error ? { error: result.error } : {}) } }));
    } catch (reason) {
      setTests((current) => ({ ...current, [provider.id]: { ok: false, error: errorMessage(reason) } }));
    }
  }

  const providers = view?.providers ?? [];

  return (
    <div className="page models-page">
      <header className="page-header">
        <div className="page-header-actions">
          <div><h1>模型</h1><p className="page-description">接入外部模型，并决定每件事交给谁做。</p></div>
          <div className="model-page-actions">
            <button className="button button-secondary" type="button" disabled={busy} onClick={() => setProviderDialog({ mode: 'create', kind: 'api' })}>添加 API 接入</button>
            <button className="button button-secondary" type="button" disabled={busy} onClick={() => setProviderDialog({ mode: 'create', kind: 'cli' })}>添加 CLI 接入</button>
          </div>
        </div>
      </header>
      {error && <div className="notice notice-warn" role="alert">{error}</div>}
      {!view && !error && <p className="muted">正在读取模型配置…</p>}
      {view && <>
        <section className="section-block">
          <div className="section-heading"><h2>接入</h2><span className="muted">{providers.length} 个</span></div>
          {providers.length === 0
            ? <p className="empty-state">还没有接入。先添加一个 API 或 CLI。</p>
            : <div className="provider-list">
              {providers.map((provider) => <ProviderCard
                key={provider.id}
                provider={provider}
                busy={busy}
                test={tests[provider.id]}
                onEdit={() => setProviderDialog({ mode: 'edit', kind: provider.kind, provider })}
                onKey={() => setKeyTarget(provider)}
                onTest={() => void testProvider(provider)}
                onTogglePrewarm={() => void mutate(() => patch(`/api/providers/${encodeURIComponent(provider.id)}`, { prewarm: !provider.prewarm }))}
                onRestart={() => void mutate(() => post(`/api/providers/${encodeURIComponent(provider.id)}/restart`, {}))}
              />)}
            </div>}
        </section>

        <section className="section-block">
          <div className="section-heading"><div><h2>用途</h2><p className="model-help">回复建议用 API，CLI 适合后台任务。点击“使用的模型”调整降级顺序。</p></div></div>
          <div className="panel-card table-card">
            <div className="table-scroll">
              <table className="models-slot-table">
                <thead><tr><th>用途</th><th>使用的模型（按顺序降级）</th><th>温度</th><th>思考强度</th><th>最大长度</th><th>操作</th></tr></thead>
                <tbody>
                  {MODEL_SLOT_DEFS.map((definition) => {
                    const chain = view.slots[definition.slot] ?? [];
                    return <InlineSlotRow
                      key={definition.slot}
                      definition={definition}
                      chain={chain}
                      providers={providers}
                      disabled={busy}
                      onEdit={() => setSlotDialog(definition.slot)}
                      onSave={(nextChain) => saveSlotChain(definition.slot, nextChain)}
                    />;
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </>}

      {providerDialog && <ProviderDialog
        mode={providerDialog.mode}
        kind={providerDialog.kind}
        provider={providerDialog.provider}
        onClose={() => setProviderDialog(undefined)}
        onSaved={() => { setProviderDialog(undefined); void load(); }}
      />}
      {keyTarget && <KeyDialog
        provider={keyTarget}
        onClose={() => setKeyTarget(undefined)}
        onSaved={() => { setKeyTarget(undefined); void load(); }}
      />}
      {slotDialog && view && <SlotDialog
        definition={MODEL_SLOT_DEFS.find((definition) => definition.slot === slotDialog) ?? MODEL_SLOT_DEFS[0]!}
        chain={view.slots[slotDialog] ?? []}
        providers={providers}
        onClose={() => setSlotDialog(undefined)}
        onSaved={() => { setSlotDialog(undefined); void load(); }}
      />}
    </div>
  );
}
