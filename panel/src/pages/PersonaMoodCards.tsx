import { useState } from 'react';
import { DEFAULT_EMOTION_LIBRARY } from '../../../src/core/mood/emotions.ts';
import { surfaceHalfLifeMin } from '../../../src/core/mood/core.ts';
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

function holdShapeLength(shape: number): string {
  if (shape < 1.5) return '无';
  if (shape < 2.5) return '短';
  if (shape < 3.5) return '中';
  return '长';
}

export function PersonaMoodHoldCard({
  settings,
  globalSettings,
  disabled,
  onChange,
}: {
  settings: PersonaMoodSettings;
  globalSettings: {
    surfaceHalfLifeMin: number;
    surfaceHoldShape: number;
    arousalHoldShape: number;
    reserveInitial: number;
  };
  disabled: boolean;
  onChange: (settings: PersonaMoodSettings) => void;
}) {
  const surfaceShape = settings.surfaceHoldShape ?? globalSettings.surfaceHoldShape;
  const arousalShape = settings.arousalHoldShape ?? globalSettings.arousalHoldShape;
  const t50Min = surfaceHalfLifeMin(globalSettings.reserveInitial, globalSettings.surfaceHalfLifeMin);
  const tau10Min = t50Min * (1 / 9) ** (1 / surfaceShape);
  const plot = { left: 34, right: 384, top: 12, bottom: 112 };
  const plotWidth = plot.right - plot.left;
  const plotHeight = plot.bottom - plot.top;
  const xAt = (u: number) => plot.left + u / 4 * plotWidth;
  const yAt = (remaining: number) => plot.top + (1 - remaining) * plotHeight;
  const curvePath = (valueAt: (u: number) => number) => Array.from({ length: 49 }, (_, index) => {
    const u = index / 12;
    return `${index === 0 ? 'M' : 'L'}${xAt(u).toFixed(2)},${yAt(valueAt(u)).toFixed(2)}`;
  }).join(' ');
  const tau10X = xAt((1 / 9) ** (1 / surfaceShape));
  const t50X = xAt(1);

  return (
    <section className="persona-form-card persona-mood-card" aria-labelledby="persona-mood-hold-title">
      <header className="persona-mood-card-heading">
        <div>
          <h3 id="persona-mood-hold-title">停留感</h3>
          <span className="muted">先停一会儿，再回到底色；数值越大，前段越平。</span>
        </div>
      </header>
      <div className="persona-mood-hold-controls">
        <div className="persona-mood-hold-control">
          <SettingsRange
            id="persona-mood-surface-hold"
            label="心情停留感"
            hint={`1 无 · 2 短 · 3 中 · 4+ 长 · 当前${holdShapeLength(surfaceShape)}`}
            value={surfaceShape}
            min={1}
            max={6}
            step={0.5}
            display={surfaceShape.toFixed(1)}
            disabled={disabled}
            onChange={(value) => onChange({ ...settings, surfaceHoldShape: value })}
          />
          <div className="persona-mood-hold-control-footer">
            <span>{settings.surfaceHoldShape === undefined ? `继承全局 ${surfaceShape.toFixed(1)}` : '人设覆盖'}</span>
            <button
              className="persona-mood-small-button"
              type="button"
              disabled={disabled || settings.surfaceHoldShape === undefined}
              onClick={() => onChange({ ...settings, surfaceHoldShape: undefined })}
            >恢复全局</button>
          </div>
        </div>
        <div className="persona-mood-hold-control">
          <SettingsRange
            id="persona-mood-arousal-hold"
            label="兴奋停留感"
            hint={`1 无 · 2 短 · 3 中 · 4+ 长 · 当前${holdShapeLength(arousalShape)}`}
            value={arousalShape}
            min={1}
            max={6}
            step={0.5}
            display={arousalShape.toFixed(1)}
            disabled={disabled}
            onChange={(value) => onChange({ ...settings, arousalHoldShape: value })}
          />
          <div className="persona-mood-hold-control-footer">
            <span>{settings.arousalHoldShape === undefined ? `继承全局 ${arousalShape.toFixed(1)}` : '人设覆盖'}</span>
            <button
              className="persona-mood-small-button"
              type="button"
              disabled={disabled || settings.arousalHoldShape === undefined}
              onClick={() => onChange({ ...settings, arousalHoldShape: undefined })}
            >恢复全局</button>
          </div>
        </div>
      </div>
      <div className="persona-mood-hold-preview">
        <svg className="persona-mood-hold-chart" role="img" aria-label="停留感曲线预览" viewBox="0 0 400 144">
          <line className="persona-mood-hold-axis" x1={plot.left} y1={plot.bottom} x2={plot.right} y2={plot.bottom} />
          <line className="persona-mood-hold-gridline" x1={plot.left} y1={yAt(0.5)} x2={plot.right} y2={yAt(0.5)} />
          <path className="persona-mood-hold-exponential" d={curvePath((u) => 2 ** -u)} />
          <path className="persona-mood-hold-hill" d={curvePath((u) => 1 / (1 + u ** surfaceShape))} />
          <line className="persona-mood-hold-marker" x1={tau10X} y1={yAt(0.9)} x2={tau10X} y2={plot.bottom} />
          <circle className="persona-mood-hold-point" cx={tau10X} cy={yAt(0.9)} r="3" />
          <text className="persona-mood-hold-marker-label" x={tau10X} y={plot.top - 1} textAnchor="middle">τ10</text>
          <line className="persona-mood-hold-marker" x1={t50X} y1={yAt(0.5)} x2={t50X} y2={plot.bottom} />
          <circle className="persona-mood-hold-point" cx={t50X} cy={yAt(0.5)} r="3" />
          <text className="persona-mood-hold-marker-label" x={t50X} y={plot.top - 1} textAnchor="middle">T50</text>
          <text className="persona-mood-hold-axis-label" x={plot.left} y="130" textAnchor="middle">0</text>
          <text className="persona-mood-hold-axis-label" x={xAt(2)} y="130" textAnchor="middle">2×T50</text>
          <text className="persona-mood-hold-axis-label" x={plot.right} y="130" textAnchor="middle">4×T50</text>
        </svg>
        <div className="persona-mood-hold-legend">
          <span><i className="is-exponential" />旧指数</span>
          <span><i className="is-hill" />当前 Hill</span>
          <span>τ10 ≈ {tau10Min.toFixed(1)} 分钟 · T50 = {t50Min.toFixed(1)} 分钟</span>
        </div>
      </div>
      <p className="persona-mood-global-note">未设置人设覆盖时继承全局形状；预览按初始心灵能量对应的心情 T50 绘制。</p>
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
