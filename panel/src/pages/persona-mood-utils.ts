import {
  DEFAULT_CUSTOM_EMOTION_POINT,
  DEFAULT_EMOTION_LIBRARY,
  buildEmotionLibrary,
  defaultEmotionEdge,
  type EmotionEdge,
} from '../../../src/core/mood/emotions.ts';
import {
  PersonaMoodSchema,
  serializePersonaMood,
  type PersonaMoodSettings,
} from '../../../src/persona/mood.ts';
import type { PersonaSectionsForm } from '../persona-sections.ts';

export type EmotionCoordinateAxis = 'valence' | 'arousal' | 'dominance';
export type EmotionEdgeSetting = keyof EmotionEdge;
export interface MoodEdgeSelection { from: string; to: string }
export interface ResolvedMoodEdge extends EmotionEdge { modified: boolean }

export function resolveMoodEdge(settings: PersonaMoodSettings, from: string, to: string): ResolvedMoodEdge {
  const library = buildEmotionLibrary(settings.emotions, settings.coordinates);
  const source = library.find((emotion) => emotion.name === from);
  const target = library.find((emotion) => emotion.name === to);
  if (!source || !target || from === to) throw new Error('切换边必须连接两个不同的已选情绪');
  const defaults = defaultEmotionEdge(source, target);
  const override = settings.edgeOverrides[from]?.[to];
  const edge = {
    margin: override?.margin ?? defaults.margin,
    dwell: override?.dwell ?? defaults.dwell,
    jump: override?.jump ?? defaults.jump,
  };
  return {
    ...edge,
    modified: Math.abs(edge.margin - defaults.margin) >= 1e-9
      || edge.dwell !== defaults.dwell
      || edge.jump !== defaults.jump,
  };
}

export function updateMoodSubSetting<K extends 'subMax' | 'subTh'>(
  settings: PersonaMoodSettings,
  key: K,
  value: PersonaMoodSettings[K],
): PersonaMoodSettings {
  return PersonaMoodSchema.parse({ ...settings, [key]: value });
}

export const MOOD_CHART_VIEW = {
  width: 600,
  height: 360,
  left: 42,
  top: 24,
  right: 580,
  bottom: 322,
} as const;

export function moodOutgoingTargets(settings: PersonaMoodSettings, from: string): string[] {
  if (!settings.emotions.includes(from)) return [];
  return settings.emotions.filter((name) => name !== from);
}

export function selectMoodSource(
  current: MoodEdgeSelection,
  from: string,
  emotions: readonly string[],
): MoodEdgeSelection {
  if (!emotions.includes(from)) return current;
  const to = current.to !== from && emotions.includes(current.to)
    ? current.to
    : emotions.find((name) => name !== from) ?? from;
  return { from, to };
}

export function selectMoodEdge(
  current: MoodEdgeSelection,
  from: string,
  to: string,
  emotions: readonly string[],
): MoodEdgeSelection {
  if (from === to || !emotions.includes(from) || !emotions.includes(to)) return current;
  return { from, to };
}

export function addMoodEmotion(settings: PersonaMoodSettings, rawName: string): PersonaMoodSettings {
  const name = rawName.trim();
  if (!name) throw new Error('请输入情绪名称');
  if (name.length > 32) throw new Error('情绪名称不能超过 32 个字符');
  if (settings.emotions.includes(name)) throw new Error('已经有了');
  if (settings.emotions.length >= 64) throw new Error('情绪最多 64 种');
  return PersonaMoodSchema.parse({ ...settings, emotions: [...settings.emotions, name] });
}

export function removeMoodEmotion(settings: PersonaMoodSettings, name: string): PersonaMoodSettings {
  if (!settings.emotions.includes(name)) return settings;
  if (settings.emotions.length <= 1) throw new Error('至少保留一种情绪');
  const coordinates = Object.fromEntries(
    Object.entries(settings.coordinates).filter(([emotion]) => emotion !== name),
  ) as PersonaMoodSettings['coordinates'];
  const edgeOverrides: PersonaMoodSettings['edgeOverrides'] = {};
  for (const [from, destinations] of Object.entries(settings.edgeOverrides)) {
    if (from === name) continue;
    const remaining = Object.fromEntries(
      Object.entries(destinations).filter(([to]) => to !== name),
    );
    if (Object.keys(remaining).length > 0) edgeOverrides[from] = remaining;
  }
  return PersonaMoodSchema.parse({
    ...settings,
    emotions: settings.emotions.filter((emotion) => emotion !== name),
    coordinates,
    edgeOverrides,
  });
}

export function restoreMissingMoodEmotions(settings: PersonaMoodSettings): PersonaMoodSettings {
  const present = new Set(settings.emotions);
  const missing = DEFAULT_EMOTION_LIBRARY
    .map((emotion) => emotion.name)
    .filter((name) => !present.has(name));
  if (missing.length === 0) return settings;
  return PersonaMoodSchema.parse({ ...settings, emotions: [...settings.emotions, ...missing] });
}

export function updateMoodEdgeSetting<K extends EmotionEdgeSetting>(
  settings: PersonaMoodSettings,
  from: string,
  to: string,
  key: K,
  value: EmotionEdge[K],
): PersonaMoodSettings {
  if (from === to) throw new Error('切换目标必须与来源不同');
  const library = buildEmotionLibrary(settings.emotions, settings.coordinates);
  const source = library.find((emotion) => emotion.name === from);
  const target = library.find((emotion) => emotion.name === to);
  if (!source || !target) throw new Error('切换边必须连接已选情绪');
  const defaults = defaultEmotionEdge(source, target);
  const next: PersonaMoodSettings['edgeOverrides'] = Object.fromEntries(
    Object.entries(settings.edgeOverrides).map(([name, destinations]) => [
      name,
      Object.fromEntries(Object.entries(destinations).map(([targetName, edge]) => [targetName, { ...edge }])),
    ]),
  );
  const edge = { ...(next[from]?.[to] ?? {}) };
  const isDefault = key === 'margin'
    ? Math.abs(Number(value) - defaults.margin) < 1e-9
    : value === defaults[key];
  if (isDefault) delete edge[key];
  else edge[key] = value as never;
  if (Object.keys(edge).length > 0) {
    next[from] = { ...(next[from] ?? {}), [to]: edge };
  } else if (next[from]) {
    delete next[from]![to];
    if (Object.keys(next[from]!).length === 0) delete next[from];
  }
  return PersonaMoodSchema.parse({ ...settings, edgeOverrides: next });
}

export function updateMoodCoordinate(
  settings: PersonaMoodSettings,
  name: string,
  axis: EmotionCoordinateAxis,
  value: number,
): PersonaMoodSettings {
  const emotion = buildEmotionLibrary(settings.emotions, settings.coordinates)
    .find((candidate) => candidate.name === name);
  if (!emotion) throw new Error('情绪不在人设集合中');
  if (!Number.isFinite(value)) throw new Error('情绪坐标必须是有限数字');
  const limits = axis === 'arousal' ? [0, 1] as const : [-1, 1] as const;
  const rounded = Number(Math.max(limits[0], Math.min(limits[1], value)).toFixed(2));
  const coordinate = {
    valence: emotion.valence,
    arousal: emotion.arousal,
    dominance: emotion.dominance,
    [axis]: rounded,
  };
  const defaultPoint = DEFAULT_EMOTION_LIBRARY.find((candidate) => candidate.name === name)
    ?? DEFAULT_CUSTOM_EMOTION_POINT;
  const isDefault = Math.abs(coordinate.valence - defaultPoint.valence) < 1e-9
    && Math.abs(coordinate.arousal - defaultPoint.arousal) < 1e-9
    && Math.abs(coordinate.dominance - defaultPoint.dominance) < 1e-9;
  const coordinates = { ...settings.coordinates };
  if (isDefault) delete coordinates[name];
  else coordinates[name] = coordinate;
  return PersonaMoodSchema.parse({ ...settings, coordinates });
}

export function moodCoordinateFromPointer(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
): { valence: number; arousal: number } {
  if (rect.width <= 0 || rect.height <= 0) return { valence: 0, arousal: DEFAULT_CUSTOM_EMOTION_POINT.arousal };
  const x = (clientX - rect.left) * (MOOD_CHART_VIEW.width / rect.width);
  const y = (clientY - rect.top) * (MOOD_CHART_VIEW.height / rect.height);
  const xRatio = Math.max(0, Math.min(1, (x - MOOD_CHART_VIEW.left) / (MOOD_CHART_VIEW.right - MOOD_CHART_VIEW.left)));
  const yRatio = Math.max(0, Math.min(1, (y - MOOD_CHART_VIEW.top) / (MOOD_CHART_VIEW.bottom - MOOD_CHART_VIEW.top)));
  return {
    valence: Number((-1 + xRatio * 2).toFixed(2)),
    arousal: Number((1 - yRatio).toFixed(2)),
  };
}

export function withPersonaMoodSettings(
  form: PersonaSectionsForm,
  settings: PersonaMoodSettings,
): PersonaSectionsForm {
  const metadata = { ...form.metadata };
  const overrides = serializePersonaMood(settings);
  if (overrides) metadata.mood = overrides;
  else delete metadata.mood;
  return { ...form, metadata };
}
