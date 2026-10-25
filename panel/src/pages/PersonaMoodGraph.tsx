import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { buildEmotionLibrary, moodRegionOf, type PadEmotion } from '../../../src/core/mood/emotions.ts';
import type { PersonaMoodSettings } from '../../../src/persona/mood.ts';
import {
  MOOD_CHART_VIEW,
  isMoodDragStarted,
  moodCoordinateFromPointer,
  moodOutgoingTargets,
  nearestMoodPoint,
  placeMoodEmotionLabels,
  resolveMoodEdge,
} from './persona-mood-utils.ts';

interface PointerPress {
  pointerId: number;
  name: string;
  startClientX: number;
  startClientY: number;
  startValence: number;
  startArousal: number;
}

interface DragPreview extends PointerPress { valence: number; arousal: number }

function chartX(valence: number): number {
  return MOOD_CHART_VIEW.left + ((valence + 1) / 2) * (MOOD_CHART_VIEW.right - MOOD_CHART_VIEW.left);
}

function chartY(arousal: number): number {
  return MOOD_CHART_VIEW.bottom - arousal * (MOOD_CHART_VIEW.bottom - MOOD_CHART_VIEW.top);
}

function pointFor(emotion: PadEmotion, drag: DragPreview | null): PadEmotion {
  if (drag?.name !== emotion.name) return emotion;
  return { ...emotion, valence: drag.valence, arousal: drag.arousal };
}

function selectOnKey(event: KeyboardEvent<SVGGElement>, action: () => void): void {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  action();
}

export function PersonaMoodGraph({
  settings,
  selectedFrom,
  selectedTo,
  onSelectPoint,
  onSelectTo,
  onCoordinatesChange,
  disabled,
}: {
  settings: PersonaMoodSettings;
  selectedFrom: string | null;
  selectedTo: string | null;
  onSelectPoint: (name: string) => void;
  onSelectTo: (name: string) => void;
  onCoordinatesChange: (name: string, valence: number, arousal: number) => void;
  disabled: boolean;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const pressRef = useRef<PointerPress | null>(null);
  const dragRef = useRef<DragPreview | null>(null);
  const [drag, setDrag] = useState<DragPreview | null>(null);
  const [hoveredTarget, setHoveredTarget] = useState<string | null>(null);
  const emotions = buildEmotionLibrary(settings.emotions, settings.coordinates);
  const points = new Map(emotions.map((emotion) => [emotion.name, pointFor(emotion, drag)]));
  const chart = MOOD_CHART_VIEW;
  const pointPositions = emotions.map((emotion) => {
    const point = points.get(emotion.name)!;
    return { name: emotion.name, x: chartX(point.valence), y: chartY(point.arousal) };
  });
  const labelPositions = new Map(placeMoodEmotionLabels(pointPositions).map((label) => [label.name, label]));
  const outgoing = moodOutgoingTargets(settings, selectedFrom)
    .flatMap((name) => {
      if (selectedFrom === null) return [];
      const source = points.get(selectedFrom);
      const target = points.get(name);
      if (!source || !target) return [];
      return [{ name, source, target, edge: resolveMoodEdge(settings, selectedFrom, name) }];
    });
  const xNegative = chartX(-0.15);
  const xPositive = chartX(0.3);
  const yNegative = chartY(0.55);
  const yPositive = chartY(0.5);
  const hint = selectedFrom === null
    ? '先点一个情绪'
    : selectedTo === null ? `${selectedFrom} → 再点它要去的情绪` : `${selectedFrom} → ${selectedTo}`;

  function beginPointPress(event: PointerEvent<SVGGElement>) {
    if (event.button !== 0 || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const x = (event.clientX - rect.left) * (chart.width / rect.width);
    const y = (event.clientY - rect.top) * (chart.height / rect.height);
    const name = nearestMoodPoint(pointPositions, x, y, 15);
    const point = name ? points.get(name) : undefined;
    if (!name || !point) return;
    event.preventDefault();
    try { svgRef.current.setPointerCapture(event.pointerId); } catch { /* capture may be unavailable in synthetic events */ }
    pressRef.current = {
      pointerId: event.pointerId,
      name,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startValence: point.valence,
      startArousal: point.arousal,
    };
  }

  function updateDrag(event: PointerEvent<SVGSVGElement>) {
    const press = pressRef.current;
    if (!press || event.pointerId !== press.pointerId || disabled) return;
    if (!dragRef.current && !isMoodDragStarted(press.startClientX, press.startClientY, event.clientX, event.clientY)) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const coordinate = moodCoordinateFromPointer(event.clientX, event.clientY, rect);
    const next = {
      ...press,
      ...(dragRef.current ?? { valence: press.startValence, arousal: press.startArousal }),
      ...coordinate,
    };
    dragRef.current = next;
    setDrag(next);
  }

  function finishPointer(event: PointerEvent<SVGSVGElement>, commit: boolean) {
    const press = pressRef.current;
    if (!press || event.pointerId !== press.pointerId) return;
    const currentDrag = dragRef.current;
    const crossedThreshold = isMoodDragStarted(press.startClientX, press.startClientY, event.clientX, event.clientY);
    const dragged = currentDrag !== null || commit && !disabled && crossedThreshold;
    let finalDrag: DragPreview | null = null;
    if (dragged && commit && !disabled) {
      const rect = event.currentTarget.getBoundingClientRect();
      const coordinate = moodCoordinateFromPointer(event.clientX, event.clientY, rect);
      finalDrag = { ...(currentDrag ?? { ...press, valence: press.startValence, arousal: press.startArousal }), ...coordinate };
    }
    pressRef.current = null;
    dragRef.current = null;
    setDrag(null);
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* pointer capture may already be released */ }
    if (!commit) return;
    if (finalDrag) {
      if (finalDrag.valence !== press.startValence || finalDrag.arousal !== press.startArousal) {
        onCoordinatesChange(press.name, finalDrag.valence, finalDrag.arousal);
      }
    } else if (!dragged) onSelectPoint(press.name);
  }

  function trimmedLine(source: PadEmotion, target: PadEmotion) {
    const x1 = chartX(source.valence);
    const y1 = chartY(source.arousal);
    const x2 = chartX(target.valence);
    const y2 = chartY(target.arousal);
    const dx = x2 - x1;
    const dy = y2 - y1;
    const length = Math.hypot(dx, dy);
    if (length < 1) return null;
    const ux = dx / length;
    const uy = dy / length;
    const startOffset = Math.min((selectedFrom === source.name ? 7 : 5) + 3, length * 0.4);
    const endOffset = Math.min((selectedTo === target.name ? 7 : 5) + 3, length * 0.4);
    return {
      x1: x1 + ux * startOffset,
      y1: y1 + uy * startOffset,
      x2: x2 - ux * endOffset,
      y2: y2 - uy * endOffset,
    };
  }

  return (
    <div className="persona-mood-graph">
      <p className="persona-mood-graph-hint" aria-live="polite">{hint}</p>
      <svg
        ref={svgRef}
        className="persona-mood-chart"
        viewBox={`0 0 ${chart.width} ${chart.height}`}
        role="group"
        aria-label="愉悦与唤醒情绪坐标图；点击情绪选择切换，拖动超过四像素调整坐标"
        onPointerMove={updateDrag}
        onPointerUp={(event) => finishPointer(event, true)}
        onPointerCancel={(event) => finishPointer(event, false)}
      >
        <defs>
          <marker id="persona-mood-arrow" markerWidth="6" markerHeight="6" viewBox="0 0 6 6" refX="5" refY="3" orient="auto" markerUnits="userSpaceOnUse">
            <path d="M0 0 L6 3 L0 6 Z" className="persona-mood-arrow-muted" />
          </marker>
          <marker id="persona-mood-arrow-selected" markerWidth="6" markerHeight="6" viewBox="0 0 6 6" refX="5" refY="3" orient="auto" markerUnits="userSpaceOnUse">
            <path d="M0 0 L6 3 L0 6 Z" className="persona-mood-arrow-selected-fill" />
          </marker>
        </defs>
        <rect x={chart.left} y={chart.top} width={xNegative - chart.left} height={yNegative - chart.top} className="persona-mood-region persona-mood-region-unpleasant" />
        <rect x={chart.left} y={yNegative} width={xNegative - chart.left} height={chart.bottom - yNegative} className="persona-mood-region persona-mood-region-oppressed" />
        <rect x={xNegative} y={chart.top} width={xPositive - xNegative} height={yPositive - chart.top} className="persona-mood-region persona-mood-region-aroused" />
        <rect x={xPositive} y={chart.top} width={chart.right - xPositive} height={yPositive - chart.top} className="persona-mood-region persona-mood-region-excited" />
        <rect x={xNegative} y={yPositive} width={chart.right - xNegative} height={chart.bottom - yPositive} className="persona-mood-region persona-mood-region-calm" />
        <text x={chart.left + 6} y={chart.top + 12} className="persona-mood-region-label">不愉快</text>
        <text x={chart.left + 6} y={yNegative + 12} className="persona-mood-region-label">压抑</text>
        <text x={xNegative + 6} y={chart.top + 12} className="persona-mood-region-label">唤醒</text>
        <text x={xPositive + 6} y={chart.top + 12} className="persona-mood-region-label">兴奋</text>
        <text x={xNegative + 6} y={yPositive + 12} className="persona-mood-region-label">平静</text>
        <line x1={chart.left} y1={chart.bottom} x2={chart.right} y2={chart.bottom} className="persona-mood-axis" />
        <line x1={chart.left} y1={chart.top} x2={chart.left} y2={chart.bottom} className="persona-mood-axis" />
        <text x={chart.right} y={chart.height - 6} textAnchor="end" className="persona-mood-axis-label">愉快 →</text>
        <text x={chart.left - 2} y={chart.top - 8} className="persona-mood-axis-label">唤醒 ↑</text>
        {outgoing.map(({ name, source, target, edge }) => {
          const line = trimmedLine(source, target);
          if (!line) return null;
          const selected = selectedTo === name;
          const isHovered = hoveredTarget === name;
          const marker = selected ? 'url(#persona-mood-arrow-selected)' : 'url(#persona-mood-arrow)';
          const label = `${selectedFrom} → ${name}，门槛 ${edge.margin.toFixed(2)}，停留 ${edge.dwell} 分钟${edge.jump ? '' : '，不可直接切换'}`;
          return (
            <g
              key={`${selectedFrom}-${name}`}
              className={`persona-mood-edge${selected ? ' is-selected' : ''}${isHovered ? ' is-hovered' : ''}${edge.jump ? '' : ' is-blocked'}`}
              role="button"
              tabIndex={0}
              aria-pressed={selected}
              aria-label={label}
              onClick={() => onSelectTo(name)}
              onKeyDown={(event) => selectOnKey(event, () => onSelectTo(name))}
            >
              <line {...line} markerEnd={marker} />
              <line className="persona-mood-edge-hit" {...line} />
            </g>
          );
        })}
        {emotions.map((emotion) => {
          const point = points.get(emotion.name)!;
          const source = selectedFrom === emotion.name;
          const target = selectedTo === emotion.name;
          const selected = source || target;
          const region = moodRegionOf(point.valence, point.arousal);
          const label = labelPositions.get(emotion.name)!;
          return (
            <g
              key={emotion.name}
              className={`persona-mood-point${source ? ' is-selected is-source' : ''}${target ? ' is-target' : ''}${drag?.name === emotion.name ? ' is-dragging' : ''}`}
              role="button"
              tabIndex={0}
              aria-pressed={selected}
              data-region={region}
              aria-label={`${emotion.name}，愉悦 ${point.valence.toFixed(2)}，唤醒 ${point.arousal.toFixed(2)}，掌控 ${point.dominance.toFixed(2)}；${selectedFrom === null ? '点击设为来源' : source ? '再次点击取消选择' : '点击设为切换目标'}${disabled ? '' : '，拖动超过四像素可调整坐标'}`}
              onKeyDown={(event) => selectOnKey(event, () => onSelectPoint(emotion.name))}
              onPointerEnter={() => setHoveredTarget(emotion.name)}
              onPointerLeave={() => setHoveredTarget((current) => current === emotion.name ? null : current)}
              onPointerDown={beginPointPress}
            >
              <circle className="persona-mood-point-hit" cx={chartX(point.valence)} cy={chartY(point.arousal)} r={15} />
              <circle cx={chartX(point.valence)} cy={chartY(point.arousal)} r={selected ? 7 : 5} />
              <text
                x={label.x}
                y={label.y}
                textAnchor={label.anchor}
                className={selected ? 'is-selected' : ''}
              >{emotion.name}</text>
            </g>
          );
        })}
      </svg>
      {selectedFrom !== null && (
        <div className="persona-mood-edge-chips" role="group" aria-label={`${selectedFrom} 的出边，按门槛从低到高排列`}>
          {outgoing.map(({ name, edge }) => {
            const selected = selectedTo === name;
            return (
              <button
                className={`persona-mood-edge-chip${selected ? ' is-selected' : ''}${edge.jump ? '' : ' is-blocked'}`}
                type="button"
                key={name}
                title={`${selectedFrom} → ${name} · 停留 ${edge.dwell} 分钟 · ${edge.jump ? '允许直接切换' : '不可直接切换'}`}
                aria-label={`${selectedFrom}到${name}，门槛 ${edge.margin.toFixed(2)}，${edge.jump ? '允许直接切换' : '不可直接切换'}`}
                aria-pressed={selected}
                onClick={() => onSelectTo(name)}
              >
                <span>→ {name}</span><span>{edge.margin.toFixed(2)}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
