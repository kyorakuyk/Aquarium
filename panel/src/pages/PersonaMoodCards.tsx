import { useState } from 'react';
import { DEFAULT_EMOTION_LIBRARY } from '../../../src/core/mood/emotions.ts';
import type { PersonaMoodSettings } from '../../../src/persona/mood.ts';
import {
  addMoodEmotion,
  removeMoodEmotion,
  restoreMissingMoodEmotions,
  updateMoodSubSetting,
} from './persona-mood-utils.ts';

export function SettingsRange({
  id,
  label,
  value,
  min,
  max,
  step,
  display,
  hint,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <div className="persona-mood-slider">
      <label className="persona-mood-slider-heading" htmlFor={id}>
        <span>{label}</span>
        {hint && <span className="persona-mood-slider-hint">{hint}</span>}
      </label>
      <div className="persona-mood-slider-row">
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(Number(event.currentTarget.value))}
        />
        <output htmlFor={id}>{display}</output>
      </div>
    </div>
  );
}

export function PersonaMoodLibraryCard({
  settings,
  selectedName,
  onSelectEmotion,
  disabled,
  onChange,
}: {
  settings: PersonaMoodSettings;
  selectedName?: string | null;
  onSelectEmotion?: (name: string) => void;
  disabled: boolean;
  onChange: (settings: PersonaMoodSettings) => void;
}) {
  const [newName, setNewName] = useState('');
  const [message, setMessage] = useState('');
  const missing = DEFAULT_EMOTION_LIBRARY.map((emotion) => emotion.name).filter((name) => !settings.emotions.includes(name));

  function add(rawName: string) {
    if (disabled) return;
    try {
      onChange(addMoodEmotion(settings, rawName));
      setNewName('');
      setMessage('');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '添加情绪失败');
    }
  }

  return (
    <section className="persona-form-card persona-mood-card" aria-labelledby="persona-mood-library-title">
      <header className="persona-mood-card-heading">
        <div><h3 id="persona-mood-library-title">我的情绪</h3><span className="muted">{settings.emotions.length} 种 · 名字不能重复，同名的会沿用情绪库里的默认数据</span></div>
      </header>
      <div className="persona-mood-emotion-tags">
        {settings.emotions.map((name) => (
          <span className={`persona-mood-emotion-tag${selectedName === name ? ' is-selected' : ''}`} key={name}>
            <button
              className="persona-mood-emotion-name"
              type="button"
              aria-pressed={selectedName === name}
              onClick={() => onSelectEmotion?.(name)}
            >{name}</button>
            <button
              className="persona-mood-emotion-remove"
              type="button"
              disabled={disabled || settings.emotions.length <= 1}
              aria-label={`删除情绪 ${name}`}
              onClick={() => {
                try { onChange(removeMoodEmotion(settings, name)); setMessage(''); }
                catch (error) { setMessage(error instanceof Error ? error.message : '删除情绪失败'); }
              }}
            >×</button>
          </span>
        ))}
      </div>
      <form className="persona-mood-add-form" onSubmit={(event) => { event.preventDefault(); add(newName); }}>
        <label className="sr-only" htmlFor="persona-mood-new-name">新情绪名称</label>
        <input
          id="persona-mood-new-name"
          value={newName}
          maxLength={32}
          placeholder="添加一种情绪，比如：怀念"
          disabled={disabled || settings.emotions.length >= 64}
          onChange={(event) => setNewName(event.currentTarget.value)}
        />
        <button className="persona-mood-small-button" type="submit" disabled={disabled || !newName.trim() || settings.emotions.length >= 64}>添加</button>
      </form>
      {message && <p className="persona-mood-message" role="status">{message}</p>}
      {missing.length > 0 && (
        <div className="persona-mood-missing-defaults">
          <span>情绪库里还有：</span>
          {missing.map((name) => (
            <button type="button" key={name} disabled={disabled} onClick={() => add(name)}>+{name}</button>
          ))}
          <button
            type="button"
            className="persona-mood-restore-all"
            disabled={disabled || settings.emotions.length + missing.length > 64}
            onClick={() => onChange(restoreMissingMoodEmotions(settings))}
          >
            全部加回
          </button>
        </div>
      )}
    </section>
  );
}

export function PersonaMoodSubSettingsCard({
  settings,
  mainEmotion,
  subEmotions,
  disabled,
  onChange,
}: {
  settings: PersonaMoodSettings;
  mainEmotion: string;
  subEmotions: string[];
  disabled: boolean;
  onChange: (settings: PersonaMoodSettings) => void;
}) {
  return (
    <section className="persona-form-card persona-mood-card" aria-labelledby="persona-mood-subs-title">
      <header className="persona-mood-card-heading">
        <div><h3 id="persona-mood-subs-title">主情绪与副情绪</h3></div>
      </header>
      <div className="persona-mood-sub-controls">
        <SettingsRange
          id="persona-mood-sub-max"
          label="副情绪最多几个"
          hint="和主情绪同时存在，可以互相矛盾"
          value={settings.subMax}
          min={0}
          max={4}
          step={1}
          display={`${settings.subMax} 个`}
          disabled={disabled}
          onChange={(value) => onChange(updateMoodSubSetting(settings, 'subMax', value))}
        />
        <SettingsRange
          id="persona-mood-sub-th"
          label="副情绪的门槛"
          hint="强度达到主情绪的多少才算数"
          value={settings.subTh}
          min={0.2}
          max={0.9}
          step={0.05}
          display={settings.subTh.toFixed(2)}
          disabled={disabled}
          onChange={(value) => onChange(updateMoodSubSetting(settings, 'subTh', value))}
        />
      </div>
      <p className="persona-mood-preview-example">现在是 <strong>{mainEmotion}</strong>（主）{subEmotions.length > 0 ? ` · 副：${subEmotions.join('、')}` : ' · 无明显副情绪'}</p>
    </section>
  );
}

export function PersonaMoodOtherCard({
  settings,
}: {
  settings: {
    surfaceHalfLifeMin: number;
    arousalHalfLifeMin: number;
    baseline: { valence: number; arousal: number };
    senderHourlyCap: number;
  };
}) {
  return (
    <section className="persona-form-card persona-mood-card" aria-labelledby="persona-mood-other-title">
      <header className="persona-mood-card-heading">
        <div><h3 id="persona-mood-other-title">其他</h3><span className="muted">占位 · 还没做</span></div>
      </header>
      <div className="persona-mood-other-grid">
        <div><strong>回落速度</strong><span>心情多久回到底色；心灵能量越满回得越快。</span><b>愉悦 {settings.surfaceHalfLifeMin} 分钟 · 唤醒 {settings.arousalHalfLifeMin} 分钟</b></div>
        <div><strong>心情底色</strong><span>没人说话时的默认心情。</span><b>愉悦 {settings.baseline.valence.toFixed(2)} · 唤醒 {settings.baseline.arousal.toFixed(2)} · 掌控 0.00</b></div>
        <div><strong>单人影响上限</strong><span>同一个人一小时内最多能把心情拉动多少。</span><b>{settings.senderHourlyCap.toFixed(2)} / 小时</b></div>
      </div>
      <p className="persona-mood-global-note">这些值由全局心情配置控制，此处只展示，不随人设保存。</p>
    </section>
  );
}
