import { useEffect, useState } from 'react';
import { apiRequest, patch, type SleepView } from '../api.ts';
import { formatSavedAt } from '../panel-feedback.ts';

interface SleepDraft {
  enabled: boolean;
  bedtime: string;
  wake: string;
  goodnight: boolean;
}

function toDraft(view: SleepView): SleepDraft {
  return {
    enabled: view.enabled,
    bedtime: view.bedtime,
    wake: view.wake,
    goodnight: view.goodnight,
  };
}

export function SleepSettingsPanel() {
  const [draft, setDraft] = useState<SleepDraft>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [savedAt, setSavedAt] = useState('');

  useEffect(() => {
    let active = true;
    void apiRequest<SleepView>('/api/sleep').then((view) => {
      if (active) setDraft(toDraft(view));
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : '读取作息设置失败');
    });
    return () => { active = false; };
  }, []);

  async function saveField<K extends keyof SleepDraft>(field: K, value: SleepDraft[K]) {
    if (!draft || busy) return;
    setDraft((current) => current ? { ...current, [field]: value } : current);
    setBusy(true);
    setError('');
    try {
      const saved = await patch<SleepDraft>('/api/sleep', { [field]: value });
      setDraft(saved);
      setSavedAt(formatSavedAt(new Date()));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存作息设置失败');
      try {
        setDraft(toDraft(await apiRequest<SleepView>('/api/sleep')));
      } catch {
        // Keep the draft visible if the server is unavailable; the error remains actionable.
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="setting-group sleep-settings-group" aria-labelledby="sleep-settings-title">
      <div className="field-heading"><h3 id="sleep-settings-title">作息设置</h3></div>
      {error && <p className="notice notice-warn" role="alert">{error}</p>}
      {!draft && !error && <p className="muted">正在读取作息设置…</p>}
      {draft && <div className="sleep-settings-form">
        <div className="sleep-settings-grid">
          <label className="sleep-setting-toggle">
            <input type="checkbox" checked={draft.enabled} disabled={busy} onChange={(event) => void saveField('enabled', event.currentTarget.checked)} />
            <span>启用作息管理</span>
          </label>
          <label className="sleep-setting-toggle">
            <input type="checkbox" checked={draft.goodnight} disabled={busy} onChange={(event) => void saveField('goodnight', event.currentTarget.checked)} />
            <span>入睡时发送晚安</span>
          </label>
          <label><span>入睡时间</span><input type="time" value={draft.bedtime} disabled={busy} onChange={(event) => void saveField('bedtime', event.currentTarget.value)} /></label>
          <label><span>醒来时间</span><input type="time" value={draft.wake} disabled={busy} onChange={(event) => void saveField('wake', event.currentTarget.value)} /></label>
        </div>
        <div className="sleep-settings-actions">
          <span className="save-state" aria-live="polite">{busy ? '正在保存…' : savedAt ? `改动立刻生效 · ${savedAt} 已保存` : '改动立刻生效 · 修改后自动保存'}</span>
        </div>
      </div>}
    </section>
  );
}
