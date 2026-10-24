import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { buildEmotionLibrary, moodRegionOf, type PadEmotion } from '../../../src/core/mood/emotions.ts';
import type { PersonaMoodSettings } from '../../../src/persona/mood.ts';
import {
  MOOD_CHART_VIEW,
  moodCoordinateFromPointer,
  moodOutgoingTargets,
  resolveMoodEdge,
} from './persona-mood-utils.ts';

interface DragPreview {
  pointerId: number;
  name: string;
  valence: number;
  arousal: number;
  startValence: number;
  startArousal: number;
}

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
  onSelectFrom,
  onSelectTo,
  onCoordinatesChange,
  disabled,
}: {
  settings: PersonaMoodSettings;
  selectedFrom: string;
  selectedTo: string;
  onSelectFrom: (name: string) => void;
  onSelectTo: (name: string) => void;
  onCoordinatesChange: (name: string, valence: number, arousal: number) => void;
  disabled: boolean;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<DragPreview | null>(null);
  const emotions = buildEmotionLibrary(settings.emotions, settings.coordinates);
  const points = new Map(emotions.map((emotion) => [emotion.name, pointFor(emotion, drag)]));
  const outgoing = moodOutgoingTargets(settings, selectedFrom)
    .flatMap((name) => {
      const source = points.get(selectedFrom);
      const target = points.get(name);
      if (!source || !target) return [];
      return [{ name, source, target, edge: resolveMoodEdge(settings, selectedFrom, name) }];
    });
  const xNegative = chartX(-0.15);
  const xPositive = chartX(0.3);
  const yNegative = chartY(0.55);
  const yPositive = chartY(0.5);
  const chart = MOOD_CHART_VIEW;

  function updateDrag(event: PointerEvent<SVGSVGElement>) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const coordinate = moodCoordinateFromPointer(event.clientX, event.clientY, rect);
    setDrag({ ...drag, ...coordinate });
  }

  function finishDrag(event: PointerEvent<SVGSVGElement>, commit: boolean) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (commit && (drag.valence !== drag.startValence || drag.arousal !== drag.startArousal)) {
      onCoordinatesChange(drag.name, drag.valence, drag.arousal);
    }
    setDrag(null);
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch { /* pointer capture may already be released */ }
  }

  return (
    <svg
      ref={svgRef}
      className="persona-mood-chart"
      viewBox={`0 0 ${chart.width} ${chart.height}`}
      role="group"
      aria-label="愉悦与唤醒情绪坐标图；可选情绪、选择切换边并拖动点调整坐标"
      onPointerMove={updateDrag}
      onPointerUp={(event) => finishDrag(event, true)}
      onPointerCancel={(event) => finishDrag(event, false)}
    >
      <defs>
        <marker id="persona-mood-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
          <path d="M0 0 L8 4 L0 8 Z" className="persona-mood-arrow-muted" />
        </marker>
        <marker id="persona-mood-arrow-selected" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
          <path d="M0 0 L8 4 L0 8 Z" className="persona-mood-arrow-selected-fill" />
        </marker>
      </defs>
      <rect x={chart.left} y={chart.top} width={xNegative - chart.left} height={yNegative - chart.top} className="persona-mood-region persona-mood-region-unpleasant" />
      <rect x={chart.left} y={yNegative} width={xNegative - chart.left} height={chart.bottom - yNegative} className="persona-mood-region persona-mood-region-oppressed" />
      <rect x={xNegative} y={chart.top} width={xPositive - xNegative} height={yPositive - chart.top} className="persona-mood-region persona-mood-region-aroused" />
      <rect x={xPositive} y={chart.top} width={chart.right - xPositive} height={yPositive - chart.top} className="persona-mood-region persona-mood-region-excited" />
      <rect x={xNegative} y={yPositive} width={chart.right - xNegative} height={chart.bottom - yPositive} className="persona-mood-region persona-mood-region-calm" />
      <text x={(chart.left + xNegative) / 2} y={(chart.top + yNegative) / 2} className="persona-mood-region-label">不愉快</text>
      <text x={(chart.left + xNegative) / 2} y={(yNegative + chart.bottom) / 2} className="persona-mood-region-label">压抑</text>
      <text x={(xNegative + xPositive) / 2} y={(chart.top + yPositive) / 2} className="persona-mood-region-label">唤醒</text>
      <text x={(xPositive + chart.right) / 2} y={(chart.top + yPositive) / 2} className="persona-mood-region-label">兴奋</text>
      <text x={(xNegative + chart.right) / 2} y={(yPositive + chart.bottom) / 2} className="persona-mood-region-label">平静</text>
      <line x1={chart.left} y1={chart.bottom} x2={chart.right} y2={chart.bottom} className="persona-mood-axis" />
      <line x1={chart.left} y1={chart.top} x2={chart.left} y2={chart.bottom} className="persona-mood-axis" />
      <text x={chart.left} y={chart.height - 6} className="persona-mood-axis-label">不愉快</text>
      <text x={chart.right} y={chart.height - 6} textAnchor="end" className="persona-mood-axis-label">愉快</text>
      <text x={chart.left - 2} y={chart.top - 8} className="persona-mood-axis-label">唤醒 ↑</text>
      {outgoing.map(({ name, source, target, edge }) => {
        const selected = selectedTo === name;
        const marker = selected ? 'url(#persona-mood-arrow-selected)' : 'url(#persona-mood-arrow)';
        const label = `${selectedFrom} → ${name}，门槛 ${edge.margin.toFixed(2)}，停留 ${edge.dwell} 分钟${edge.jump ? '' : '，不可直接切换'}`;
        return (
          <g
            key={`${selectedFrom}-${name}`}
            className={`persona-mood-edge${selected ? ' is-selected' : ''}${edge.jump ? '' : ' is-blocked'}`}
            role="button"
            tabIndex={0}
            aria-pressed={selected}
            aria-label={label}
            onClick={() => onSelectTo(name)}
            onKeyDown={(event) => selectOnKey(event, () => onSelectTo(name))}
          >
            <line x1={chartX(source.valence)} y1={chartY(source.arousal)} x2={chartX(target.valence)} y2={chartY(target.arousal)} markerEnd={marker} />
            <line className="persona-mood-edge-hit" x1={chartX(source.valence)} y1={chartY(source.arousal)} x2={chartX(target.valence)} y2={chartY(target.arousal)} />
          </g>
        );
      })}
      {emotions.map((emotion, index) => {
        const point = points.get(emotion.name)!;
        const selected = selectedFrom === emotion.name;
        const region = moodRegionOf(point.valence, point.arousal);
        const textAnchor = point.valence > 0.55 ? 'end' : 'start';
        const textX = chartX(point.valence) + (textAnchor === 'end' ? -8 : 8);
        const textY = chartY(point.arousal) + (index % 2 === 0 ? -5 : 12);
        return (
          <g
            key={emotion.name}
            className={`persona-mood-point${selected ? ' is-selected' : ''}${drag?.name === emotion.name ? ' is-dragging' : ''}`}
            role="button"
            tabIndex={0}
            aria-pressed={selected}
            data-region={region}
            aria-label={`${emotion.name}，愉悦 ${point.valence.toFixed(2)}，唤醒 ${point.arousal.toFixed(2)}，掌控 ${point.dominance.toFixed(2)}；点击设为切换来源${disabled ? '' : '，按住拖动调整坐标'}`}
            onClick={() => onSelectFrom(emotion.name)}
            onKeyDown={(event) => selectOnKey(event, () => onSelectFrom(emotion.name))}
            onPointerDown={(event) => {
              onSelectFrom(emotion.name);
              if (disabled) return;
              event.preventDefault();
              svgRef.current?.setPointerCapture(event.pointerId);
              setDrag({
                pointerId: event.pointerId,
                name: emotion.name,
                valence: point.valence,
                arousal: point.arousal,
                startValence: point.valence,
                startArousal: point.arousal,
              });
            }}
          >
            <circle className="persona-mood-point-hit" cx={chartX(point.valence)} cy={chartY(point.arousal)} r={15} />
            <circle cx={chartX(point.valence)} cy={chartY(point.arousal)} r={selected ? 7 : 5} />
            <text x={textX} y={textY} textAnchor={textAnchor}>{emotion.name}</text>
          </g>
        );
      })}
      <text x={chart.right} y={chart.height - 6} textAnchor="end" className="persona-mood-axis-title">愉悦 V</text>
    </svg>
  );
}
