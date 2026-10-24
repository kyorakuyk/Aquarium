import { useState } from 'react';
import type { InteractionSettingsView, SessionView } from '../api.ts';
import { formatSavedAt } from '../panel-feedback.ts';
import { sessionSettingsInheritanceCopy } from '../session-settings-copy.ts';
import { createSessionSettingsTarget, type SessionSettingsTarget } from './SessionSettingsPanel.tsx';

const FEATURES = [
  { key: 'react', label: '贴表情' },
  { key: 'poke', label: '戳一戳' },
  { key: 'recall', label: '撤回' },
  { key: 'admin', label: '群管理' },
] as const;

type FeatureKey = typeof FEATURES[number]['key'];

export function InteractionSettingsPanel({
  session,
  busy,
  onPatch,
  onRefresh,
  onError,
}: {
  session: SessionView;
  busy: boolean;
  onPatch: (target: SessionSettingsTarget, values: Record<string, unknown>) => Promise<void>;
  onRefresh: (target: SessionSettingsTarget) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const [savedAt, setSavedAt] = useState('');

  async function update(values: Record<string, unknown>) {
    const target = createSessionSettingsTarget(session);
    try {
      await onPatch(target, values);
      await onRefresh(target);
      setSavedAt(formatSavedAt(new Date()));
    } catch (error) {
      onError(error);
    }
  }

  function toggle(feature: FeatureKey, enabled: boolean) {
    void update({ interactions: { [feature]: { enabled } } });
  }

  function restore(feature: FeatureKey) {
    void update({ interactions: { [feature]: null } });
  }

  const interactions: InteractionSettingsView = session.interactions;
  return <section className="interaction-settings setting-group" aria-labelledby="interaction-settings-title">
    <div className="section-heading">
      <div><h2 id="interaction-settings-title">交互动作</h2><p className="muted">按会话单独开启；Gate 与紧急闭嘴始终优先。</p></div>
      {savedAt && <span className="saved-time">已保存 {savedAt}</span>}
    </div>
    <div className="interaction-toggle-list">
      {FEATURES.map(({ key, label }) => {
        const overridden = session.interactionOverrides.includes(key);
        const inheritance = sessionSettingsInheritanceCopy(session.kind, overridden);
        return <div className="interaction-toggle-row" key={key}>
          <label className="interaction-toggle">
            <span>{label}</span>
            <input
              type="checkbox"
              checked={interactions[key].enabled}
              disabled={busy}
              onChange={(event) => toggle(key, event.currentTarget.checked)}
            />
          </label>
          {inheritance && <div className="field-inheritance-state" data-overridden={overridden}>
            <span>{inheritance.statusLabel}</span>
            {inheritance.restoreLabel && <button
              className="text-button"
              type="button"
              aria-label={`${label}恢复继承`}
              disabled={busy}
              onClick={() => restore(key)}
            >{inheritance.restoreLabel}</button>}
          </div>}
        </div>;
      })}
    </div>
  </section>;
}
