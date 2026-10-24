import type { PersonaMoodSettings } from '../../../src/persona/mood.ts';
import { resolveMoodEdge } from './persona-mood-utils.ts';

function difficulty(margin: number): 'easy' | 'medium' | 'hard' {
  if (margin < 0.08) return 'easy';
  if (margin < 0.2) return 'medium';
  return 'hard';
}

export function PersonaMoodEdgeMatrix({
  settings,
  selectedFrom,
  selectedTo,
  onSelect,
}: {
  settings: PersonaMoodSettings;
  selectedFrom: string;
  selectedTo: string;
  onSelect: (from: string, to: string) => void;
}) {
  return (
    <div className="persona-mood-matrix-scroll" role="region" aria-label="全部切换一览" tabIndex={0}>
      <table className="persona-mood-matrix">
        <thead>
          <tr>
            <th scope="col">从＼到</th>
            {settings.emotions.map((name) => <th scope="col" key={name}>{name}</th>)}
          </tr>
        </thead>
        <tbody>
          {settings.emotions.map((from) => (
            <tr key={from}>
              <th scope="row">{from}</th>
              {settings.emotions.map((to) => {
                if (from === to) return <td className="persona-mood-matrix-diagonal" key={to} aria-label={`${from}到${to}（同一情绪）`} />;
                const edge = resolveMoodEdge(settings, from, to);
                const selected = selectedFrom === from && selectedTo === to;
                const modified = edge.modified;
                const className = [
                  'persona-mood-matrix-cell',
                  `is-${difficulty(edge.margin)}`,
                  edge.jump ? '' : 'is-blocked',
                  selected ? 'is-selected' : '',
                ].filter(Boolean).join(' ');
                return (
                  <td key={to}>
                    <button
                      className={className}
                      type="button"
                      aria-label={`${from}到${to}，门槛 ${edge.margin.toFixed(2)}，至少停留 ${edge.dwell} 分钟${edge.jump ? '' : '，不可直接切换'}，${modified ? '已修改' : '默认值'}`}
                      aria-pressed={selected}
                      onClick={() => onSelect(from, to)}
                    >
                      <span>{edge.margin.toFixed(2)}</span>
                      {modified && <i aria-hidden="true" />}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="persona-mood-matrix-hint">颜色越深，切换门槛越高；斜线表示不可直接切换，圆点表示已修改。</p>
    </div>
  );
}
