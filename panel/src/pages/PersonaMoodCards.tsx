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
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label className="persona-mood-slider" htmlFor={id}>
      <span className="persona-mood-slider-heading"><span>{label}</span><output htmlFor={id}>{display}</output></span>
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
    </label>
  );
}

export function PersonaMoodLibraryCard({
  settings,
  disabled,
  onChange,
}: {
  settings: PersonaMoodSettings;
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
        <div><h3 id="persona-mood-library-title">我的情绪</h3><p>名称不能重复；库内同名情绪会沿用默认坐标。</p></div>
        <span className="muted">{settings.emotions.length} 种</span>
      </header>
      <div className="persona-mood-emotion-tags">
        {settings.emotions.map((name) => (
          <button
            className="persona-mood-emotion-tag"
            type="button"
            key={name}
            disabled={disabled || settings.emotions.length <= 1}
            aria-label={`删除情绪 ${name}`}
            onClick={() => {
              try { onChange(removeMoodEmotion(settings, name)); setMessage(''); }
              catch (error) { setMessage(error instanceof Error ? error.message : '删除情绪失败'); }
            }}
          >
            {name}<span aria-hidden="true">×</span>
          </button>
        ))}
      </div>
      <form className="persona-mood-add-form" onSubmit={(event) => { event.preventDefault(); add(newName); }}>
        <label className="sr-only" htmlFor="persona-mood-new-name">新情绪名称</label>
        <input
          id="persona-mood-new-name"
          value={newName}
          maxLength={32}
          placeholder="输入一个情绪名称"
          disabled={disabled || settings.emotions.length >= 64}
          onChange={(event) => setNewName(event.currentTarget.value)}
        />
        <button className="button button-secondary" type="submit" disabled={disabled || !newName.trim() || settings.emotions.length >= 64}>添加</button>
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
        <div><h3 id="persona-mood-subs-title">主情绪与副情绪</h3><p>副情绪与主情绪同时存在，也可以互相矛盾。</p></div>
      </header>
      <div className="persona-mood-sub-controls">
        <SettingsRange
          id="persona-mood-sub-max"
          label="副情绪最多几个"
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
        <div><h3 id="persona-mood-other-title">其他</h3><p>占位 · 还没做</p></div>
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
