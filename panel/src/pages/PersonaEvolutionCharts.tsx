import type { PersonaTraits, PersonaVersionSummary } from '../api.ts';
import { PERSONA_TRAIT_LABELS } from '../persona-sections.ts';

export type PersonaEvolutionView = 'increment' | 'trajectory' | 'radar';

export const PERSONA_TRAIT_COLORS: Record<keyof PersonaTraits, string> = {
  order: '#1C5F5A',
  morality: '#C2702B',
  talk: '#3B6EA8',
  mind: '#8A4F7D',
  humor: '#5E7F2E',
  openness: '#A23E48',
  imitation: '#7A6A2E',
};

function formatDate(timestamp: number, includeYear = false): string {
  return new Date(timestamp).toLocaleDateString('zh-CN', {
    ...(includeYear ? { year: '2-digit' } : {}),
    month: '2-digit',
    day: '2-digit',
  });
}

function IncrementChart({ versions }: { versions: PersonaVersionSummary[] }) {
  const ordered = [...versions].reverse();
  const width = Math.max(360, ordered.length * 40 + 44);
  const left = 28;
  const slot = (width - left - 10) / Math.max(ordered.length, 1);
  const baseline = 72;
  const barWidth = Math.max(2, Math.min(5, slot / 10));
  const gap = Math.max(1, Math.min(2, barWidth / 2));
  const clusterWidth = barWidth * PERSONA_TRAIT_LABELS.length + gap * (PERSONA_TRAIT_LABELS.length - 1);

  return (
    <div className="persona-evolution-chart-scroll">
      <svg width={width} height="128" viewBox={`0 0 ${width} 128`} role="img" aria-label="每个保存版本的七维性格增量">
        <line x1={left} x2={width - 8} y1={baseline} y2={baseline} stroke="var(--muted)" strokeWidth="1" />
        <text x="4" y="26" fill="var(--muted)" fontSize="9">+4</text>
        <text x="12" y={baseline + 3} fill="var(--muted)" fontSize="9">0</text>
        <text x="4" y="122" fill="var(--muted)" fontSize="9">−4</text>
        {ordered.map((version, index) => {
          const x = left + index * slot + (slot - clusterWidth) / 2;
          return (
            <g key={version.id}>
              <rect x={left + index * slot + 2} y="13" width={Math.max(8, slot - 4)} height="96" rx="4" fill="var(--surface-2)" />
              {PERSONA_TRAIT_LABELS.map((dimension, dimensionIndex) => {
                const delta = dimension.key === 'imitation' ? 0 : version.traitsDelta[dimension.key];
                const height = delta === 0 ? 2 : Math.abs(delta) * 11;
                return (
                  <rect
                    key={dimension.key}
                    x={x + dimensionIndex * (barWidth + gap)}
                    y={delta > 0 ? baseline - height : delta < 0 ? baseline : baseline - 1}
                    width={barWidth}
                    height={height}
                    rx="1"
                    fill={PERSONA_TRAIT_COLORS[dimension.key]}
                    opacity={delta === 0 ? 0.42 : 1}
                  >
                    <title>{`${dimension.title} ${delta > 0 ? '+' : ''}${delta}`}</title>
                  </rect>
                );
              })}
              {(index === 0 || index === ordered.length - 1 || index % Math.ceil(ordered.length / 7) === 0) && (
                <text x={left + index * slot + slot / 2} y="123" textAnchor="middle" fill="var(--muted)" fontSize="8">
                  {formatDate(version.savedAt)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function TrajectoryChart({ versions, currentTraits }: { versions: PersonaVersionSummary[]; currentTraits: PersonaTraits }) {
  const ordered = [...versions].reverse();
  const width = Math.max(360, ordered.length * 40 + 48);
  const height = 168;
  const left = 31;
  const right = width - 12;
  const top = 15;
  const bottom = 132;
  const xAt = (index: number) => ordered.length <= 1 ? (left + right) / 2 : left + index * (right - left) / (ordered.length - 1);
  const yAt = (value: number) => top + (2 - value) * (bottom - top) / 4;

  return (
    <div className="persona-evolution-chart-scroll">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="七维性格随保存版本变化的轨迹">
        {[-2, -1, 0, 1, 2].map((value) => (
          <g key={value}>
            <line x1={left} x2={right} y1={yAt(value)} y2={yAt(value)} stroke="var(--line)" strokeWidth={value === 0 ? 1.5 : 1} />
            <text x="4" y={yAt(value) + 3} fill="var(--muted)" fontSize="9">{value > 0 ? `+${value}` : value === 0 ? '0' : `−${Math.abs(value)}`}</text>
          </g>
        ))}
        {ordered.map((version, index) => (
          <line key={version.id} x1={xAt(index)} x2={xAt(index)} y1={top} y2={bottom} stroke="var(--muted)" strokeDasharray="2 4" strokeOpacity=".42" />
        ))}
        {PERSONA_TRAIT_LABELS.map((dimension) => {
          const points = ordered.map((version, index) => {
            const value = dimension.key === 'imitation' ? currentTraits.imitation : version.traits[dimension.key];
            return `${xAt(index)},${yAt(value)}`;
          }).join(' ');
          return (
            <g key={dimension.key}>
              <polyline points={points} fill="none" stroke={PERSONA_TRAIT_COLORS[dimension.key]} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
              {ordered.map((version, index) => {
                const value = dimension.key === 'imitation' ? currentTraits.imitation : version.traits[dimension.key];
                return <circle key={version.id} cx={xAt(index)} cy={yAt(value)} r="2.5" fill={PERSONA_TRAIT_COLORS[dimension.key]}><title>{`${formatDate(version.savedAt, true)} · ${dimension.title} ${value}`}</title></circle>;
              })}
            </g>
          );
        })}
        {ordered.map((version, index) => (
          (index === 0 || index === ordered.length - 1 || index % Math.ceil(ordered.length / 7) === 0) && (
            <text key={version.id} x={xAt(index)} y="154" textAnchor="middle" fill="var(--muted)" fontSize="8">{formatDate(version.savedAt)}</text>
          )
        ))}
      </svg>
    </div>
  );
}

function RadarChart({
  currentTraits,
  selectedVersion,
}: {
  currentTraits: PersonaTraits;
  selectedVersion: PersonaVersionSummary | undefined;
}) {
  const centerX = 240;
  const centerY = 174;
  const radius = 88;
  const angleAt = (index: number) => -Math.PI / 2 + index * Math.PI * 2 / PERSONA_TRAIT_LABELS.length;
  const pointAt = (index: number, value: number, scale = 1) => {
    const distance = ((value + 2) / 4) * radius * scale;
    const angle = angleAt(index);
    return { x: centerX + Math.cos(angle) * distance, y: centerY + Math.sin(angle) * distance };
  };
  const polygonPoints = (traits: PersonaTraits) => PERSONA_TRAIT_LABELS.map((dimension, index) => {
    const point = pointAt(index, traits[dimension.key]);
    return `${point.x},${point.y}`;
  }).join(' ');

  return (
    <div className="persona-evolution-radar">
      <svg viewBox="0 0 480 350" role="img" aria-label="底色与所选历史版本的七维雷达图">
        {[0, 2, 4].map((step) => {
          const value = step - 2;
          const points = PERSONA_TRAIT_LABELS.map((_, index) => {
            const point = pointAt(index, value);
            return `${point.x},${point.y}`;
          }).join(' ');
          return <polygon key={value} points={points} fill="none" stroke="var(--line)" strokeWidth={value === 0 ? 2 : 1} />;
        })}
        {PERSONA_TRAIT_LABELS.map((dimension, index) => {
          const outer = pointAt(index, 2);
          const label = pointAt(index, 2, 1.42);
          const horizontal = Math.cos(angleAt(index));
          const anchor = horizontal < -0.25 ? 'end' : horizontal > 0.25 ? 'start' : 'middle';
          return (
            <g key={dimension.key}>
              <line x1={centerX} y1={centerY} x2={outer.x} y2={outer.y} stroke="var(--line)" strokeWidth="1" />
              <text x={label.x} y={label.y - 3} textAnchor={anchor} fill="var(--muted)" fontSize="8">
                <tspan x={label.x} dy="0">{dimension.low}</tspan>
                <tspan x={label.x} dy="10">{dimension.high}</tspan>
              </text>
            </g>
          );
        })}
        <polygon points={polygonPoints(currentTraits)} fill="#1C5F5A" fillOpacity=".08" stroke="#1C5F5A" strokeWidth="2" />
        {selectedVersion && <polygon points={polygonPoints(selectedVersion.traits)} fill="#C2702B" fillOpacity=".08" stroke="#C2702B" strokeWidth="2" strokeDasharray="4 3" />}
        {PERSONA_TRAIT_LABELS.map((dimension, index) => {
          const point = pointAt(index, currentTraits[dimension.key]);
          return <circle key={dimension.key} cx={point.x} cy={point.y} r="3" fill="#1C5F5A"><title>{`${dimension.title} · 底色 ${currentTraits[dimension.key]}`}</title></circle>;
        })}
        {selectedVersion && PERSONA_TRAIT_LABELS.map((dimension, index) => {
          const point = pointAt(index, selectedVersion.traits[dimension.key]);
          return <circle key={dimension.key} cx={point.x} cy={point.y} r="3" fill="#C2702B"><title>{`${dimension.title} · 历史版本 ${selectedVersion.traits[dimension.key]}`}</title></circle>;
        })}
      </svg>
      <div className="persona-radar-legend" aria-label="雷达图系列">
        <span><i className="persona-radar-dot is-base" />底色</span>
        <span><i className="persona-radar-dot is-history" />所选历史版本</span>
      </div>
    </div>
  );
}

export function PersonaEvolutionCharts({
  view,
  versions,
  currentTraits,
  selectedVersion,
}: {
  view: PersonaEvolutionView;
  versions: PersonaVersionSummary[];
  currentTraits: PersonaTraits;
  selectedVersion: PersonaVersionSummary | undefined;
}) {
  if (view === 'increment') return <IncrementChart versions={versions} />;
  if (view === 'trajectory') return <TrajectoryChart versions={versions} currentTraits={currentTraits} />;
  return <RadarChart currentTraits={currentTraits} selectedVersion={selectedVersion} />;
}
