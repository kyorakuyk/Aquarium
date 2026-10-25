import { useEffect, useState } from 'react';
import {
  MAX_RESERVE_DELTA,
  RESERVE_BUFFER_MAX,
  RESERVE_BUFFER_WATER_COST,
  RESERVE_RECOVERY_COST,
  SENDER_RESERVE_CAP,
} from '../../../src/core/mood/core.ts';
import {
  DEFAULT_PERSONA_ENERGY,
  PersonaEnergySchema,
  type PersonaEnergyMultipliers,
} from '../../../src/persona/energy.ts';
import { apiRequest } from '../api.ts';
import type { PersonaSectionsForm } from '../persona-sections.ts';
import {
  baseHalfLifeHours,
  estimateRecoveryTo80,
  formatHalfLife,
  formatRecoveryEstimate,
  type EnergySource,
} from './persona-energy-utils.ts';
type MoodPreview = { account: number; reserve: number; energySource: EnergySource };

const ENERGY_CONTROLS: ReadonlyArray<{
  key: keyof PersonaEnergyMultipliers;
  title: string;
  description: string;
  group: '获得' | '消耗' | '界限';
}> = [
  { key: 'aloneRecovery', title: '独处时恢复', description: '半衰期按倍率反向变化；0 表示暂停独处回能。', group: '获得' },
  { key: 'companyRecovery', title: '有人陪时恢复', description: '只在能量来源允许的陪伴状态下生效。', group: '获得' },
  { key: 'warmCharge', title: '暖心事件充能', description: '调节正向评估给水位带来的增量。', group: '获得' },
  { key: 'bufferCost', title: '缓冲坏情绪的代价', description: '调节水库吸收负面情绪时的耗水。', group: '消耗' },
  { key: 'calmRecoveryCost', title: '平复心情的代价', description: '调节负面心情回到基线时的耗水。', group: '消耗' },
  { key: 'hurtCost', title: '伤人事件的直接消耗', description: '调节负向评估直接扣除的水位。', group: '消耗' },
  { key: 'senderHourlyCap', title: '同一个人每小时最多影响', description: '正负增量共用此上限；0 表示该发送者不能改变水位。', group: '界限' },
];

function isEnergySource(value: unknown): value is EnergySource {
  return value === 'inner' || value === 'outer' || value === 'mixed';
}

function controlReadout(key: keyof PersonaEnergyMultipliers, value: number, source: EnergySource): string {
  if (key === 'aloneRecovery') return formatHalfLife(baseHalfLifeHours(source, false), value);
  if (key === 'companyRecovery') return formatHalfLife(baseHalfLifeHours(source, true), value);
  if (key === 'warmCharge') {
    return `模型上限 +${MAX_RESERVE_DELTA.toFixed(2)}；单人小时上限前水位最多 +${(MAX_RESERVE_DELTA * 2 * value).toFixed(2)}`;
  }
  if (key === 'bufferCost') {
    return `吸收最多 ${RESERVE_BUFFER_MAX.toFixed(2)} 时耗水 ${(RESERVE_BUFFER_MAX * RESERVE_BUFFER_WATER_COST * value).toFixed(3)}`;
  }
  if (key === 'calmRecoveryCost') {
    return `心情回升 0.10 时耗水 ${(0.1 * RESERVE_RECOVERY_COST * value).toFixed(3)}`;
  }
  if (key === 'hurtCost') {
    return `模型下限 −${MAX_RESERVE_DELTA.toFixed(2)}；单人小时上限前水位最多 −${(MAX_RESERVE_DELTA * 2 * value).toFixed(2)}`;
  }
  return `每位发送者最多 ${(SENDER_RESERVE_CAP * value).toFixed(2)} / 小时`;
}

function isMoodPreview(value: unknown): value is MoodPreview {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return Number.isSafeInteger(record.account)
    && typeof record.reserve === 'number'
    && Number.isFinite(record.reserve)
    && record.reserve >= 0
    && record.reserve <= 1
    && isEnergySource(record.energySource);
}

export function PersonaEnergyEditor({
  form,
  onChange,
  previewAccountId,
  disabled,
}: {
  form: PersonaSectionsForm;
  onChange: (form: PersonaSectionsForm) => void;
  previewAccountId: number | null;
  disabled: boolean;
}) {
  const [preview, setPreview] = useState<MoodPreview | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [previewBusy, setPreviewBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const parsed = PersonaEnergySchema.safeParse(form.metadata.energy ?? {});
  const settings = parsed.success ? parsed.data : DEFAULT_PERSONA_ENERGY;
  const source = isEnergySource(form.metadata.energySource) ? form.metadata.energySource : 'mixed';
  const selectedPreview = preview?.account === previewAccountId ? preview : null;

  useEffect(() => {
    let active = true;
    if (previewAccountId === null) {
      setPreview(null);
      setPreviewError('');
      setPreviewBusy(false);
      return () => { active = false; };
    }
    setPreview(null);
    setPreviewError('');
    setPreviewBusy(true);
    void apiRequest<MoodPreview>(`/api/mood?account=${previewAccountId}`)
      .then((result) => {
        if (!active) return;
        if (!isMoodPreview(result)) {
          console.warn('心灵能量预览返回数据无效', result);
          setPreviewError('服务端还是旧版本，重启后再看');
        } else if (result.account === previewAccountId) setPreview(result);
        else setPreviewError('返回的 QQ 号与所选眷属不一致，请重新读取。');
      })
      .catch((error: unknown) => {
        if (!active) return;
        const message = error instanceof Error ? error.message : '';
        setPreviewError(message === 'Not found' || message.includes('404')
          ? '服务端还是旧版本，重启后再看'
          : message || '读取当前心灵能量失败');
      })
      .finally(() => { if (active) setPreviewBusy(false); });
    return () => { active = false; };
  }, [previewAccountId, reloadKey]);

  function updateMultiplier(key: keyof PersonaEnergyMultipliers, rawValue: string) {
    if (disabled || !parsed.success) return;
    const numericValue = Number(rawValue);
    if (!Number.isFinite(numericValue)) return;
    const value = Math.round(Math.max(0, Math.min(3, numericValue)) * 10) / 10;
    onChange({ ...form, metadata: { ...form.metadata, energy: { ...settings, [key]: value } } });
  }

  function resetMultipliers() {
    if (disabled) return;
    onChange({ ...form, metadata: { ...form.metadata, energy: { ...DEFAULT_PERSONA_ENERGY } } });
  }

  const groupedControls = [
    { title: '获得', sub: '怎么回满' },
    { title: '消耗', sub: '怎么被耗掉' },
    { title: '界限', sub: '防止一个人把我掏空' },
  ] as const;
  const recovery = settings as PersonaEnergyMultipliers;
  const sourceLabel = source === 'inner' ? '向内（I）' : source === 'outer' ? '向外（E）' : '混合';

  return (
    <div className="persona-energy-editor">
      <div className="persona-energy-intro">
        <p>我的能量来源：<strong>{sourceLabel}</strong>。来源在「我是谁」里改。每个滑杆是在默认值上乘的倍率，×1 保持原行为。</p>
        <p className="persona-energy-current">
          <span>当前水位：<strong>{selectedPreview ? `${Math.round(selectedPreview.reserve * 100)}%` : previewBusy ? '读取中…' : '未读取'}</strong></span>
          {previewAccountId !== null && <span>预览 QQ：<strong>{previewAccountId}</strong></span>}
        </p>
        {!parsed.success && <p className="persona-energy-error" role="alert">人设 energy 配置无效，请修复 YAML 后再保存。</p>}
        {previewError && (
          <div className="persona-energy-error-row">
            <p className="persona-energy-error" role="alert">{previewError}</p>
            <button className="pae-btn" type="button" disabled={previewBusy} onClick={() => setReloadKey((value) => value + 1)}>重新读取</button>
          </div>
        )}
        {!selectedPreview && !previewBusy && !previewError && <p className="persona-energy-note">选择预览 QQ 后读取真实水位；估算会按当前人设来源和滑杆值计算。</p>}
      </div>

      {groupedControls.map(({ title: group, sub }) => (
        <section className="persona-energy-group" key={group} aria-labelledby={`persona-energy-${group}`}>
          <h3 id={`persona-energy-${group}`}>{group}<span>{sub}</span></h3>
          <div className="persona-energy-controls">
            {ENERGY_CONTROLS.filter((control) => control.group === group).map((control) => {
              const value = settings[control.key];
              const id = `persona-energy-${control.key}`;
              return (
                <div className="persona-energy-row" key={control.key}>
                  <div className="persona-energy-row-heading">
                    <label htmlFor={id}>{control.title}</label>
                    <p>{control.description}</p>
                  </div>
                  <input
                    id={id}
                    className="persona-energy-range"
                    type="range"
                    min={0}
                    max={3}
                    step={0.1}
                    value={value}
                    aria-label={`${control.title}倍率`}
                    aria-valuetext={`乘以 ${value.toFixed(2)}`}
                    disabled={disabled || !parsed.success}
                    onChange={(event) => updateMultiplier(control.key, event.currentTarget.value)}
                  />
                  <div className="persona-energy-value">
                    <output htmlFor={id}>×{value.toFixed(2)}</output>
                    <span className="persona-energy-readout">{controlReadout(control.key, value, source)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}
      <div className="persona-energy-footer">
        {selectedPreview ? (
          <p className="persona-energy-estimates" aria-label="预计恢复到百分之八十的时间">
            <span>独处恢复到 80%：<strong>{formatRecoveryEstimate(estimateRecoveryTo80(selectedPreview.reserve, source, false, recovery.aloneRecovery), source, false, recovery.aloneRecovery)}</strong></span>
            <span>有人陪时恢复到 80%：<strong>{formatRecoveryEstimate(estimateRecoveryTo80(selectedPreview.reserve, source, true, recovery.companyRecovery), source, true, recovery.companyRecovery)}</strong></span>
          </p>
        ) : <span />}
        <button className="pae-btn" type="button" disabled={disabled} onClick={resetMultipliers}>全部恢复 ×1</button>
      </div>
      <p className="persona-energy-note">预览按当前水位估算；“心情回升耗水”只统计水位支出。负向评估、缓冲、恢复与单人上限仍按核心计算顺序分别生效。</p>
    </div>
  );
}
