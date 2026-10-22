import { useEffect, useState } from 'react';
import { apiRequest, patch } from '../api.ts';
import { formatSavedAt } from '../panel-feedback.ts';
import type { StickerSettings } from '../sticker-types.ts';

interface StickerSettingsCardProps {
  onNotice: (text: string) => void;
  onError: (text: string) => void;
}

const fields: Array<{
  key: 'maxRatio' | 'onlyStickerRatio' | 'cooldownSec' | 'candidates';
  label: string;
  min: number;
  max: number;
  step: number;
}> = [
  { key: 'maxRatio', label: '带表情回复上限', min: 0, max: 1, step: 0.05 },
  { key: 'onlyStickerRatio', label: '只发表情上限', min: 0, max: 1, step: 0.05 },
  { key: 'cooldownSec', label: '冷却（秒）', min: 0, max: 86_400, step: 1 },
  { key: 'candidates', label: '候选个数', min: 1, max: 50, step: 1 },
];

export function StickerSettingsCard({ onNotice, onError }: StickerSettingsCardProps) {
  const [settings, setSettings] = useState<StickerSettings>();
  const [draft, setDraft] = useState<StickerSettings>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    void apiRequest<StickerSettings>('/api/stickers/settings').then((current) => {
      if (!active) return;
      setSettings(current);
      setDraft(current);
    }).catch((reason) => {
      if (active) onError(reason instanceof Error ? reason.message : '读取表情设置失败');
    });
    return () => { active = false; };
  }, [onError]);

  async function saveField<K extends keyof StickerSettings>(field: K, value: StickerSettings[K]): Promise<void> {
    if (!draft || saving) return;
    setDraft((current) => current ? { ...current, [field]: value } : current);
    setSaving(true);
    onNotice('');
    onError('');
    try {
      const next = await patch<StickerSettings>('/api/stickers/settings', { [field]: value });
      setSettings(next);
      setDraft(next);
      onError('');
      onNotice(`改动立刻生效 · ${formatSavedAt(new Date())} 已保存`);
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : '保存表情设置失败');
      try {
        const current = await apiRequest<StickerSettings>('/api/stickers/settings');
        setSettings(current);
        setDraft(current);
      } catch {
        // Keep the draft visible if the server is unavailable; the error remains actionable.
      }
    } finally {
      setSaving(false);
    }
  }

  if (!draft || !settings) {
    return <section className="panel-card stickers-settings stickers-settings-loading">正在读取发送设置…</section>;
  }

  return (
    <section className="panel-card stickers-settings" aria-labelledby="stickers-settings-title">
      <h2 id="stickers-settings-title">发送设置</h2>
      <div className="stickers-settings-grid">
        <div className="stickers-switch-row">
          <span>允许发表情</span>
          <button
            className={`switch ${draft.enabled ? 'is-on' : ''}`}
            type="button"
            role="switch"
            aria-checked={draft.enabled}
            disabled={saving}
            onClick={() => void saveField('enabled', !draft.enabled)}
          ><span /></button>
        </div>
        {fields.map((field) => (
          <label key={field.key}>
            <span>{field.label}</span>
            <input
              type="number"
              min={field.min}
              max={field.max}
              step={field.step}
              value={draft[field.key]}
              disabled={saving}
              onChange={(event) => {
                setDraft({ ...draft, [field.key]: Number(event.currentTarget.value) });
                onError('');
                onNotice('');
              }}
              onBlur={(event) => {
                const input = event.currentTarget;
                const rawValue = input.value.trim();
                const value = Number(rawValue);
                if (!rawValue || !input.validity.valid || !Number.isFinite(value)) {
                  setDraft(settings);
                  onError('请输入有效范围内的数值。');
                  return;
                }
                if (value !== settings[field.key]) void saveField(field.key, value);
              }}
              onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
            />
          </label>
        ))}
        <p className="save-state" aria-live="polite">{saving ? '正在保存…' : '改动立刻生效；数值输入完成后自动保存'}</p>
      </div>
    </section>
  );
}
