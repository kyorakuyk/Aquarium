import { useEffect, useState } from 'react';
import { apiRequest, patch } from '../api.ts';
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

  async function save(): Promise<void> {
    if (!draft || saving) return;
    setSaving(true);
    try {
      const next = await patch<StickerSettings>('/api/stickers/settings', draft);
      setSettings(next);
      setDraft(next);
      onError('');
      onNotice('表情设置已保存并热重载。');
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : '保存表情设置失败');
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
            onClick={() => setDraft({ ...draft, enabled: !draft.enabled })}
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
              onChange={(event) => setDraft({ ...draft, [field.key]: Number(event.target.value) })}
            />
          </label>
        ))}
        <div className="stickers-settings-actions">
          <button
            className="button button-primary"
            type="button"
            disabled={saving || JSON.stringify(draft) === JSON.stringify(settings)}
            onClick={() => void save()}
          >保存</button>
        </div>
      </div>
    </section>
  );
}
