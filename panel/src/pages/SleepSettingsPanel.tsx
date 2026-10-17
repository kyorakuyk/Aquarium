import { useEffect, useState, type FormEvent } from 'react';
import { apiRequest, patch, type SleepView } from '../api.ts';

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

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    setBusy(true);
    try {
      await patch('/api/sleep', draft);
      const saved = await apiRequest<SleepView>('/api/sleep');
      setDraft(toDraft(saved));
      setSavedAt(new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date()));
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存作息设置失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="setting-group sleep-settings-group" aria-labelledby="sleep-settings-title">
      <div className="field-heading"><h3 id="sleep-settings-title">作息设置</h3></div>
      {error && <p className="notice notice-warn" role="alert">{error}</p>}
      {!draft && !error && <p className="muted">正在读取作息设置…</p>}
      {draft && <form className="sleep-settings-form" onSubmit={(event) => void save(event)}>
        <div className="sleep-settings-grid">
          <label className="sleep-setting-toggle">
            <input type="checkbox" checked={draft.enabled} disabled={busy} onChange={(event) => setDraft({ ...draft, enabled: event.currentTarget.checked })} />
            <span>启用作息管理</span>
          </label>
          <label className="sleep-setting-toggle">
            <input type="checkbox" checked={draft.goodnight} disabled={busy} onChange={(event) => setDraft({ ...draft, goodnight: event.currentTarget.checked })} />
            <span>入睡时发送晚安</span>
          </label>
          <label><span>入睡时间</span><input type="time" value={draft.bedtime} disabled={busy} onChange={(event) => setDraft({ ...draft, bedtime: event.currentTarget.value })} /></label>
          <label><span>醒来时间</span><input type="time" value={draft.wake} disabled={busy} onChange={(event) => setDraft({ ...draft, wake: event.currentTarget.value })} /></label>
        </div>
        <div className="sleep-settings-actions">
          <span className="save-state" aria-live="polite">{busy ? '正在保存…' : savedAt ? `已保存 · ${savedAt}` : '点击保存后立即生效'}</span>
          <button className="button button-primary" type="submit" disabled={busy}>{busy ? '保存中…' : '保存作息'}</button>
        </div>
      </form>}
    </section>
  );
}
