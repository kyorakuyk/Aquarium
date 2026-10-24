import type { PersonaEvolutionView } from './pages/PersonaEvolutionCharts.tsx';

export const PERSONA_EVOLUTION_VIEW_OPTIONS: readonly { key: PersonaEvolutionView; label: string }[] = [
  { key: 'increment', label: '增量' },
  { key: 'trajectory', label: '轨迹' },
  { key: 'radar', label: '雷达' },
];
