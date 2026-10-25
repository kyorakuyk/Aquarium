import { useState } from 'react';
import type { PersonaMoodSettings } from '../../../src/persona/mood.ts';
import { isMoodMatrixHeaderHovered, resolveMoodEdge } from './persona-mood-utils.ts';

/** Easy (margin 0) is very light teal; hard (0.4 and up) is deep teal. */
function rampColor(percent: number): string {
  return `color-mix(in srgb, #1C5F5A ${percent}%, #FFFFFF)`;
}

// 按当前矩阵里最小到最大的门槛拉开色阶，深浅直接对应系数大小
function marginRampPercent(margin: number, low: number, high: number): number {
  if (!Number.isFinite(margin)) return 7;
  const span = high - low;
  const t = span > 1e-6 ? (Math.max(low, Math.min(high, margin)) - low) / span : 0.5;
  return Number((7 + t * 80).toFixed(1));
}

export function PersonaMoodEdgeMatrix({
  settings,
  selectedFrom,
  selectedTo,
  onSelect,
}: {
  settings: PersonaMoodSettings;
  selectedFrom: string | null;
  selectedTo: string | null;
  onSelect: (from: string, to: string) => void;
}) {
  const [pointerHovered, setPointerHovered] = useState<{ from: string; to: string } | null>(null);
  const [focused, setFocused] = useState<{ from: string; to: string } | null>(null);
  const hovered = pointerHovered ?? focused;
  const margins = settings.emotions.flatMap((from) => settings.emotions
    .filter((to) => to !== from)
    .map((to) => resolveMoodEdge(settings, from, to).margin)
    .filter(Number.isFinite));
  const low = margins.length ? Math.min(...margins) : 0;
  const high = margins.length ? Math.max(...margins) : 0.4;
  const edgeTitle = (from: string, to: string) => {
    const edge = resolveMoodEdge(settings, from, to);
    return `${from} → ${to} · 门槛 ${edge.margin.toFixed(2)} · 停留 ${edge.dwell} 分钟 · ${edge.jump ? '允许直接切换' : '不可直接切换'} · ${edge.modified ? '已修改' : '默认值'}`;
  };
  return (
    <div className="persona-mood-matrix-scroll" role="region" aria-label="全部切换一览" tabIndex={0}>
      <table className="persona-mood-matrix">
        <thead>
          <tr>
            <th scope="col">从＼到</th>
            {settings.emotions.map((name) => (
              <th scope="col" key={name} className={isMoodMatrixHeaderHovered('column', name, hovered) ? 'is-hovered' : ''}>
                <span>{name}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {settings.emotions.map((from) => (
            <tr key={from}>
              <th scope="row" className={isMoodMatrixHeaderHovered('row', from, hovered) ? 'is-hovered' : ''}>{from}</th>
              {settings.emotions.map((to) => {
                if (from === to) return (
                  <td
                    className="persona-mood-matrix-diagonal"
                    key={to}
                    aria-label={`${from}到${to}（同一情绪）`}
                    onPointerEnter={() => setPointerHovered({ from, to })}
                    onPointerLeave={() => setPointerHovered(null)}
                  />
                );
                const edge = resolveMoodEdge(settings, from, to);
                const selected = selectedFrom === from && selectedTo === to;
                const modified = edge.modified;
                const className = [
                  'persona-mood-matrix-cell',
                  edge.jump ? '' : 'is-blocked',
                  selected ? 'is-selected' : '',
                ].filter(Boolean).join(' ');
                const title = edgeTitle(from, to);
                return (
                  <td key={to}>
                    <button
                      className={className}
                      type="button"
                      style={{ backgroundColor: rampColor(marginRampPercent(edge.margin, low, high)) }}
                      title={title}
                      aria-label={title}
                      aria-pressed={selected}
                      onPointerEnter={() => setPointerHovered({ from, to })}
                      onPointerLeave={() => setPointerHovered(null)}
                      onFocus={() => setFocused({ from, to })}
                      onBlur={() => setFocused(null)}
                      onClick={() => onSelect(from, to)}
                    >
                      {modified && <i aria-hidden="true" />}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="persona-mood-matrix-legend" role="img" aria-label="门槛从易到难">
        <span>易 {low.toFixed(2)}</span>
        {[7, 27, 47, 67, 87].map((percent, index) => (
          <i key={percent} className={`is-step-${index + 1}`} style={{ backgroundColor: rampColor(percent) }} aria-hidden="true" />
        ))}
        <span>{high.toFixed(2)} 难</span>
      </div>
      <p className="persona-mood-matrix-hint">斜线表示不可直接切换，右上角小点表示已修改。</p>
    </div>
  );
}
