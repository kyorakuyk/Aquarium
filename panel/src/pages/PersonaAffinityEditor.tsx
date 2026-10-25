import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { affinityLevelOf, DEFAULT_AFFINITY_TIERS, type AffinityTiers } from '../../../src/core/affinity/core.ts';
import {
  affinityCurveValue,
  DEFAULT_AFFINITY_CURVES,
  resolveAffinityCurves,
  type AffinityCurveId,
  type AffinityCurveSetting,
  type AffinityCurveSet,
} from '../../../src/core/affinity/curves.ts';
import { PersonaAffinitySchema, type PersonaAffinitySettings } from '../../../src/persona/affinity.ts';
import { apiRequest } from '../api.ts';
import type { PersonaAffinityPreviewView } from '../persona-affinity-types.ts';
import type { PersonaSectionsForm } from '../persona-sections.ts';
import { CURVE_PRESETS, LEVEL_LABELS, NEGATIVE_NAMES, PLOT, POSITIVE_NAMES, clamp, curvePath, formatAffinity, formatDelta, pointFromEvent, solvePointOffset } from './persona-affinity-chart-utils.ts';

type Direction = 'gain' | 'loss';
type DragState = { kind: 'point' | 'tier'; index: number };
function AffinityCurveChart({
  negative,
  tiers,
  curves,
  start,
  currentValue,
  disabled,
  onTiersChange,
  onCurveChange,
}: {
  negative: boolean;
  tiers: AffinityTiers;
  curves: AffinityCurveSet;
  start: number | null;
  currentValue: number | null;
  disabled: boolean;
  onTiersChange: (side: 'positive' | 'negative', values: number[]) => void;
  onCurveChange: (id: AffinityCurveId, curve: AffinityCurveSetting) => void;
}) {
  const [direction, setDirection] = useState<Direction>('gain');
  const drag = useRef<DragState | null>(null);
  const side = negative ? 'negative' : 'positive';
  const values = tiers[side];
  const curveId: AffinityCurveId = negative
    ? direction === 'gain' ? 'negGain' : 'negLoss'
    : direction === 'gain' ? 'posGain' : 'posLoss';
  const otherCurveId: AffinityCurveId = negative
    ? direction === 'gain' ? 'negLoss' : 'negGain'
    : direction === 'gain' ? 'posLoss' : 'posGain';
  const curve = curves[curveId];
  const startValue = negative ? -100 : 0;
  const thresholdX = (value: number) => PLOT.left + ((value - startValue) / 100) * (PLOT.right - PLOT.left);
  const affinityAtX = (x: number) => startValue + clamp((x - PLOT.left) / (PLOT.right - PLOT.left), 0, 1) * 100;
  const multiplierAtY = (y: number) => clamp((PLOT.bottom - y) * 3 / (PLOT.bottom - PLOT.top), 0, 3);
  const path = useMemo(() => curvePath(curveId, curve, tiers, negative), [curveId, curve, tiers, negative]);
  const ghostPath = useMemo(() => curvePath(otherCurveId, curves[otherCurveId], tiers, negative), [otherCurveId, curves, tiers, negative]);
  const sample = negative ? -60 : 60;
  const multiplier = affinityCurveValue(curveId, curve, sample, tiers);
  const baseDelta = direction === 'gain' ? 3 : -3;
  const sampleLevel = affinityLevelOf(sample, tiers);
  const names = negative ? NEGATIVE_NAMES : POSITIVE_NAMES;
  const labelPositions = [startValue, ...values, negative ? 0 : 100];

  function changeThreshold(index: number, requested: number) {
    const next = [...values];
    const minimum = index === 0 ? startValue : (next[index - 1] ?? startValue) + 3;
    const maximum = index === next.length - 1 ? (negative ? 0 : 100) : (next[index + 1] ?? (negative ? 0 : 100)) - 3;
    next[index] = Math.round(clamp(requested, minimum, maximum));
    onTiersChange(side, next);
  }

  function movePoint(index: number, requestedX: number, requestedY: number) {
    const previous = curve.points[index - 1]?.x ?? 0;
    const next = curve.points[index + 1]?.x ?? 1;
    const x = clamp(requestedX, index === 0 ? 0 : previous + 0.02, index === curve.points.length - 1 ? 1 : next - 0.02);
    const setting = { ...curve, points: curve.points.map((point, pointIndex) => pointIndex === index ? { ...point, x } : { ...point }) };
    onCurveChange(curveId, solvePointOffset(curveId, setting, index, startValue + x * 100, requestedY, tiers));
  }

  function onPointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (disabled || event.button !== 0) return;
    const target = event.target as SVGElement;
    const point = pointFromEvent(event);
    if (!point) return;
    const pointIndex = target.dataset.pointIndex;
    const tierIndex = target.dataset.tierIndex;
    if (pointIndex !== undefined) drag.current = { kind: 'point', index: Number(pointIndex) };
    else if (tierIndex !== undefined) drag.current = { kind: 'tier', index: Number(tierIndex) };
    else if (target.dataset.curveHandle === 'true') {
      if (curve.points.length >= 64 || point.x < PLOT.left || point.x > PLOT.right || point.y < PLOT.top || point.y > PLOT.bottom) return;
      const ratio = Math.round(clamp((point.x - PLOT.left) / (PLOT.right - PLOT.left), 0, 1) * 1000) / 1000;
      if (curve.points.some((item) => Math.abs(item.x - ratio) < 0.02)) return;
      const points = [...curve.points, { x: ratio, dy: 0 }].sort((left, right) => left.x - right.x);
      const index = points.findIndex((item) => item.x === ratio);
      drag.current = { kind: 'point', index };
      onCurveChange(curveId, { ...curve, points });
    } else return;
    event.preventDefault();
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* 指针可能已被浏览器释放。 */ }
  }

  function onPointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    const activeDrag = drag.current;
    if (!activeDrag || disabled) return;
    const point = pointFromEvent(event);
    if (!point) return;
    if (activeDrag.kind === 'tier') changeThreshold(activeDrag.index, affinityAtX(point.x));
    else movePoint(activeDrag.index, (point.x - PLOT.left) / (PLOT.right - PLOT.left), multiplierAtY(point.y));
  }

  function onContextMenu(event: ReactMouseEvent<SVGSVGElement>) {
    const target = event.target as SVGElement;
    const index = target.dataset.pointIndex;
    if (index === undefined || disabled) return;
    event.preventDefault();
    onCurveChange(curveId, { ...curve, points: curve.points.filter((_, pointIndex) => pointIndex !== Number(index)) });
  }

  function onKeyDown(event: ReactKeyboardEvent<SVGSVGElement>) {
    if (disabled) return;
    const target = event.target as SVGElement;
    const pointIndex = target.dataset.pointIndex;
    const tierIndex = target.dataset.tierIndex;
    const step = event.shiftKey ? 5 : 1;
    if (tierIndex !== undefined && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault();
      const index = Number(tierIndex);
      changeThreshold(index, (values[index] ?? 0) + (event.key === 'ArrowRight' ? step : -step));
      return;
    }
    if (pointIndex === undefined) return;
    const index = Number(pointIndex);
    const point = curve.points[index];
    if (!point) return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      onCurveChange(curveId, { ...curve, points: curve.points.filter((_, pointIndexValue) => pointIndexValue !== index) });
    } else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault();
      const x = point.x + (event.key === 'ArrowRight' ? 0.01 : event.key === 'ArrowLeft' ? -0.01 : 0);
      const y = affinityCurveValue(curveId, curve, startValue + point.x * 100, tiers)
        + (event.key === 'ArrowUp' ? 0.1 : event.key === 'ArrowDown' ? -0.1 : 0);
      movePoint(index, x, y);
    }
  }

  const presetName = CURVE_PRESETS.find((preset) => preset.id === curve.preset)?.label ?? '默认函数';
  const currentIsVisible = currentValue !== null && currentValue >= startValue && currentValue <= startValue + 100;

  return (
    <section className="persona-affinity-chart-card" aria-label={negative ? '零下好感曲线' : '零上好感曲线'}>
      <header className="persona-affinity-chart-heading">
        <div>
          <h4>{negative ? '零下（−100 ～ 0）' : '零上（0 ～ 100）'}</h4>
          <p>{presetName} · {direction === 'gain' ? negative ? '回暖' : '增加' : negative ? '下滑' : '减少'}</p>
        </div>
        <div className="persona-affinity-direction" role="group" aria-label="变化方向">
          {(['gain', 'loss'] as const).map((item) => (
            <button type="button" key={item} disabled={disabled} aria-pressed={direction === item} className={direction === item ? 'is-active' : ''} onClick={() => setDirection(item)}>
              {item === 'gain' ? '好感增加' : '好感减少'}
            </button>
          ))}
        </div>
      </header>
      <svg
        className="persona-affinity-chart"
        viewBox={`0 0 ${PLOT.width} ${PLOT.height}`}
        role="group"
        aria-label={`${negative ? '零下' : '零上'}好感倍率图；可拖动曲线点和分界线`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => { drag.current = null; }}
        onPointerCancel={() => { drag.current = null; }}
        onContextMenu={onContextMenu}
        onKeyDown={onKeyDown}
      >
        {[0, 1, 2, 3].map((tick) => {
          const y = PLOT.bottom - (tick / 3) * (PLOT.bottom - PLOT.top);
          return <g key={tick}><line className={tick === 1 ? 'is-baseline' : ''} x1={PLOT.left} x2={PLOT.right} y1={y} y2={y} /><text className="persona-affinity-axis-label" x={PLOT.left - 8} y={y + 4} textAnchor="end">×{tick}</text></g>;
        })}
        <text className="persona-affinity-axis-title" x="10" y={PLOT.top + 2}>倍率</text>
        <path className="persona-affinity-ghost-curve" d={ghostPath} />
        {values.map((value, index) => {
          const x = thresholdX(value);
          const isStartBoundary = start !== null && !negative && index === 0 && Math.abs(value - start) < 0.5;
          return <g key={`${index}-${value}`}>
            <line className="persona-affinity-tier-line" x1={x} x2={x} y1={PLOT.top} y2={PLOT.bottom} />
            <line className="persona-affinity-tier-hit" x1={x} x2={x} y1={PLOT.top} y2={PLOT.bottom} data-tier-index={index} role="slider" tabIndex={disabled ? -1 : 0} aria-label={`分界线 ${formatAffinity(value)}`} aria-valuemin={index === 0 ? startValue : values[index - 1]! + 3} aria-valuemax={index === values.length - 1 ? startValue + 100 : values[index + 1]! - 3} aria-valuenow={value} />
            {!isStartBoundary && <text className="persona-affinity-threshold-label" x={x} y="25" textAnchor="middle">{formatAffinity(value)}</text>}
          </g>;
        })}
        {start !== null && start >= startValue && start <= startValue + 100 && (
          <g><line className="persona-affinity-start-line" x1={thresholdX(start)} x2={thresholdX(start)} y1={PLOT.top} y2={PLOT.bottom} /><text className="persona-affinity-start-label" x={thresholdX(start)} y="25" textAnchor="middle">起点 {formatAffinity(start)}</text></g>
        )}
        {currentIsVisible && currentValue !== null && (
          <line className="persona-affinity-current-line" x1={thresholdX(currentValue)} x2={thresholdX(currentValue)} y1={PLOT.top} y2={PLOT.bottom} aria-label={`当前好感 ${formatAffinity(currentValue)}`} />
        )}
        <path className="persona-affinity-active-curve" d={path} />
        <path className="persona-affinity-curve-hit" d={path} data-curve-handle="true" pointerEvents="stroke" />
        {curve.points.map((point, index) => {
          const x = PLOT.left + point.x * (PLOT.right - PLOT.left);
          const affinity = startValue + point.x * 100;
          const value = affinityCurveValue(curveId, curve, affinity, tiers);
          const y = PLOT.bottom - (value / 3) * (PLOT.bottom - PLOT.top);
          return <circle key={`${point.x}-${index}`} className="persona-affinity-point" cx={x} cy={y} r="5" data-point-index={index} role="slider" tabIndex={disabled ? -1 : 0} aria-label={`局部曲线点 ${index + 1}，好感 ${formatAffinity(affinity)}，倍率 ${value.toFixed(2)}；方向键调整，删除键移除`} aria-valuemin={0} aria-valuemax={3} aria-valuenow={value} />;
        })}
        {[0, 20, 40, 60, 80, 100].map((offset) => {
          const x = PLOT.left + (offset / 100) * (PLOT.right - PLOT.left);
          return <g key={offset}><line className="persona-affinity-x-tick" x1={x} x2={x} y1={PLOT.bottom} y2={PLOT.bottom + 4} /><text className="persona-affinity-axis-label" x={x} y={PLOT.bottom + 18} textAnchor="middle">{formatAffinity(startValue + offset)}</text></g>;
        })}
        {names.map((name, index) => {
          const left = labelPositions[index] ?? startValue;
          const right = labelPositions[index + 1] ?? startValue + 100;
          const x = thresholdX((left + right) / 2);
          return <text className="persona-affinity-tier-name" key={name} x={x} y={PLOT.bottom + 36} textAnchor="middle">{name}</text>;
        })}
      </svg>
      <div className="persona-affinity-readout">
        <span>好感 <strong>{formatAffinity(sample)}</strong>（{LEVEL_LABELS[sampleLevel]}）时倍率 <strong>×{multiplier.toFixed(2)}</strong></span>
        <span>一次原本 {baseDelta > 0 ? '+3' : '−3'} 的{direction === 'gain' ? '好事' : '坏事'}，实际 <strong>{formatDelta(baseDelta * multiplier)}</strong></span>
      </div>
      <div className="persona-affinity-presets" role="group" aria-label="曲线预设">
        {CURVE_PRESETS.map((preset) => (
          <button className={`button ${curve.preset === preset.id ? 'button-primary' : 'button-secondary'}`} type="button" key={preset.id} disabled={disabled} aria-pressed={curve.preset === preset.id} onClick={() => onCurveChange(curveId, { preset: preset.id, points: [] })}>{preset.label}</button>
        ))}
      </div>
    </section>
  );
}

export function PersonaAffinityEditor({
  form,
  onChange,
  personaId,
  previewAccountId,
  disabled,
}: {
  form: PersonaSectionsForm;
  onChange: (form: PersonaSectionsForm) => void;
  personaId: string;
  previewAccountId: number | null;
  disabled: boolean;
}) {
  const [preview, setPreview] = useState<PersonaAffinityPreviewView | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [previewBusy, setPreviewBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const parsed = PersonaAffinitySchema.safeParse(form.metadata.affinity ?? {});
  const settings = parsed.success ? parsed.data : undefined;

  useEffect(() => {
    let active = true;
    if (!personaId || previewAccountId === null) {
      setPreview(null);
      setPreviewError('');
      setPreviewBusy(false);
      return () => { active = false; };
    }
    setPreview(null);
    setPreviewError('');
    setPreviewBusy(true);
    void apiRequest<PersonaAffinityPreviewView>(`/api/personas/${encodeURIComponent(personaId)}/affinity-preview?account=${previewAccountId}`)
      .then((result) => {
        if (!active) return;
        if (result.account === previewAccountId) setPreview(result);
        else setPreviewError('返回的 QQ 号与所选眷属不一致，请重新读取。');
      })
      .catch((error: unknown) => {
        if (!active) return;
        const message = error instanceof Error ? error.message : '';
        setPreviewError(message === 'Not found' || message.includes('404')
          ? '服务端还是旧版本，重启后再看'
          : message || '读取当前好感失败');
      })
      .finally(() => { if (active) setPreviewBusy(false); });
    return () => { active = false; };
  }, [personaId, previewAccountId, reloadKey]);

  const displayedPreview = preview?.account === previewAccountId ? preview : null;
  const defaults = displayedPreview?.curveDefaults ?? DEFAULT_AFFINITY_CURVES;
  const curves = useMemo(() => resolveAffinityCurves(defaults, settings?.curves), [defaults, settings?.curves]);
  const tiers = (settings?.tiers ?? displayedPreview?.tiers ?? DEFAULT_AFFINITY_TIERS) as unknown as AffinityTiers;
  const mode = settings?.mode ?? 'inherit';
  const currentValue = displayedPreview ? displayedPreview.current[mode] : null;
  const currentLevel = currentValue === null ? null : affinityLevelOf(currentValue, tiers);

  function updateSettings(next: PersonaAffinitySettings) {
    onChange({ ...form, metadata: { ...form.metadata, affinity: next } });
  }

  function updateCurve(id: AffinityCurveId, curve: AffinityCurveSetting) {
    if (!settings) return;
    updateSettings({ ...settings, curves: { ...settings.curves, [id]: curve } });
  }

  function updateTiers(side: 'positive' | 'negative', values: number[]) {
    if (!settings) return;
    updateSettings({
      ...settings,
      tiers: {
        positive: [...tiers.positive],
        negative: [...tiers.negative],
        [side]: values,
      },
    });
  }

  return (
    <div className="persona-affinity-editor">
      <section className="persona-affinity-mode-card" aria-labelledby="persona-affinity-mode-title">
        <div className="persona-affinity-mode-heading">
          <div><h3 id="persona-affinity-mode-title">关系数据</h3><p>选择这个人设使用哪一份好感记录；分档与倍率曲线始终按人设保存。</p></div>
          {currentValue !== null && currentLevel
            ? <span className="persona-affinity-current-readout">当前 {formatAffinity(currentValue)} · {LEVEL_LABELS[currentLevel]}</span>
            : <span className="persona-affinity-current-readout">{previewBusy ? '正在读取当前好感…' : '选择预览眷属以读取当前好感'}</span>}
        </div>
        {!parsed.success && <p className="persona-affinity-error" role="alert">人设 affinity 配置无效，请切换到 Markdown 源码修复后再保存。</p>}
        {previewError && (
          <div>
            <p className="persona-affinity-error" role="alert">{previewError}</p>
            <button className="button button-secondary" type="button" disabled={previewBusy} onClick={() => setReloadKey((value) => value + 1)}>重新读取</button>
          </div>
        )}
        <div className="persona-affinity-mode-actions" role="group" aria-label="好感数据模式">
          <button className={`button ${mode === 'inherit' ? 'button-primary' : 'button-secondary'}`} type="button" disabled={disabled || !settings} aria-pressed={mode === 'inherit'} onClick={() => settings && updateSettings({ ...settings, mode: 'inherit' })}>继承账号共用记录</button>
          <button className={`button ${mode === 'independent' ? 'button-primary' : 'button-secondary'}`} type="button" disabled={disabled || !settings} aria-pressed={mode === 'independent'} onClick={() => settings && updateSettings({ ...settings, mode: 'independent' })}>使用人设独立记录</button>
        </div>
        <p className="persona-affinity-mode-note">独立记录按 QQ 账号、用户和人设隔离；首次启用从全局起点初始化。切回继承不会删除独立记录。</p>
      </section>
      {settings && (
        <div className="persona-affinity-charts">
          <AffinityCurveChart negative={false} tiers={tiers} curves={curves} start={displayedPreview?.start ?? null} currentValue={currentValue} disabled={disabled} onTiersChange={updateTiers} onCurveChange={updateCurve} />
          <AffinityCurveChart negative tiers={tiers} curves={curves} start={displayedPreview?.start ?? null} currentValue={currentValue} disabled={disabled} onTiersChange={updateTiers} onCurveChange={updateCurve} />
        </div>
      )}
      <p className="persona-affinity-editor-note">按住曲线拖动可添加局部点，右键删除；竖虚线是可拖动的关系分界，键盘方向键也可调整。蓝色点线是所选数据模式下当前账号 owner 的真实好感，橙色线是起点。每日上限仍为 +5 / −8，倍率只改变单次变化，久不说话时回到起点。</p>
    </div>
  );
}
