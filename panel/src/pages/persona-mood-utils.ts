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
export interface MoodGraphSelection { from: string | null; to: string | null }
export interface ResolvedMoodEdge extends EmotionEdge { modified: boolean }
export const PERSONA_MOOD_PREVIEW_ERRORS = {
  global: '暂时无法读取全局心情设置，已用默认底色展示；这不影响人设配置的编辑和保存。',
  account: '暂时无法读取所选 QQ 的心情预览；这不影响人设配置的编辑和保存，请稍后重试。',
  invalid: '返回的心情预览数据无效，请重新选择预览账号；这不影响人设配置的编辑和保存。',
  globalInvalid: '返回的全局心情设置无效，已用默认底色展示；这不影响人设配置的编辑和保存。',
} as const;

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

export function moodOutgoingTargets(settings: PersonaMoodSettings, from: string | null): string[] {
  if (from === null || !settings.emotions.includes(from)) return [];
  return settings.emotions
    .filter((name) => name !== from)
    .map((name, index) => ({ name, index, margin: resolveMoodEdge(settings, from, name).margin }))
    .sort((left, right) => left.margin - right.margin || left.index - right.index)
    .map(({ name }) => name);
}

export function selectMoodSource(
  current: MoodGraphSelection,
  from: string,
  emotions: readonly string[],
): MoodGraphSelection {
  if (!emotions.includes(from)) return current;
  if (current.from === null || !emotions.includes(current.from)) return { from, to: null };
  if (current.from === from) return { from: null, to: null };
  return { from: current.from, to: from };
}

export function selectMoodEdge(
  current: MoodGraphSelection,
  from: string,
  to: string,
  emotions: readonly string[],
): MoodGraphSelection {
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

export interface MoodGraphPointLayout { name: string; x: number; y: number }
export type MoodGraphLabelDirection = 'right' | 'left' | 'up' | 'down';
export interface MoodGraphLabelPosition extends MoodGraphPointLayout {
  anchor: 'start' | 'end' | 'middle';
  direction: MoodGraphLabelDirection;
}

export function nearestMoodPoint(
  points: readonly MoodGraphPointLayout[],
  x: number,
  y: number,
  hitRadius = 15,
): string | null {
  if (![x, y, hitRadius].every(Number.isFinite) || hitRadius < 0) return null;
  let nearest: string | null = null;
  let nearestDistance = hitRadius;
  for (const point of points) {
    const distance = Math.hypot(point.x - x, point.y - y);
    if (distance <= hitRadius && (nearest === null || distance < nearestDistance)) {
      nearest = point.name;
      nearestDistance = distance;
    }
  }
  return nearest;
}

export function isMoodDragStarted(startX: number, startY: number, x: number, y: number, threshold = 4): boolean {
  return Math.hypot(x - startX, y - startY) > threshold;
}

export function placeMoodEmotionLabels(points: readonly MoodGraphPointLayout[]): MoodGraphLabelPosition[] {
  const labelWidth = (name: string) => Math.max(10, Array.from(name).length * 10 + 2);
  const boxes: Array<{ name: string; left: number; right: number; top: number; bottom: number }> = [];
  const overlaps = (left: typeof boxes[number], right: typeof boxes[number]): boolean => (
    left.left < right.right + 2 && left.right + 2 > right.left
      && left.top < right.bottom + 2 && left.bottom + 2 > right.top
  );
  const nodeBox = (point: MoodGraphPointLayout) => ({
    name: point.name,
    left: point.x - 8,
    right: point.x + 8,
    top: point.y - 8,
    bottom: point.y + 8,
  });
  const result: MoodGraphLabelPosition[] = [];

  for (const point of points) {
    const width = labelWidth(point.name);
    const candidates: Array<MoodGraphLabelPosition & { box: typeof boxes[number] }> = [
      { ...point, x: point.x + 10, y: point.y + 3, anchor: 'start', direction: 'right', box: { name: point.name, left: point.x + 10, right: point.x + 10 + width, top: point.y - 7, bottom: point.y + 5 } },
      { ...point, x: point.x - 10, y: point.y + 3, anchor: 'end', direction: 'left', box: { name: point.name, left: point.x - 10 - width, right: point.x - 10, top: point.y - 7, bottom: point.y + 5 } },
      { ...point, x: point.x, y: point.y - 10, anchor: 'middle', direction: 'up', box: { name: point.name, left: point.x - width / 2, right: point.x + width / 2, top: point.y - 22, bottom: point.y - 10 } },
      { ...point, x: point.x, y: point.y + 18, anchor: 'middle', direction: 'down', box: { name: point.name, left: point.x - width / 2, right: point.x + width / 2, top: point.y + 6, bottom: point.y + 18 } },
    ];
    const scored = candidates.map((candidate) => {
      const pointCollisions = points.filter((other) => other.name !== point.name)
        .filter((other) => overlaps(candidate.box, nodeBox(other))).length;
      const labelCollisions = boxes.filter((box) => overlaps(candidate.box, box)).length;
      return { candidate, score: pointCollisions + labelCollisions };
    });
    const selected = scored.find(({ score }) => score === 0) ?? scored.reduce((best, item) => (
      item.score < best.score ? item : best
    ));
    result.push({
      name: point.name,
      x: selected.candidate.x,
      y: selected.candidate.y,
      anchor: selected.candidate.anchor,
      direction: selected.candidate.direction,
    });
    boxes.push(selected.candidate.box);
  }
  return result;
}

export function isMoodMatrixHeaderHovered(
  axis: 'row' | 'column',
  name: string,
  hovered: { from: string; to: string } | null,
): boolean {
  return hovered !== null && (axis === 'row' ? hovered.from === name : hovered.to === name);
}

export function moodMarginColorPercent(margin: number): number {
  if (!Number.isFinite(margin)) return 10;
  const bounded = Math.max(0, Math.min(0.3, margin));
  return Number((10 + (bounded / 0.3) * 65).toFixed(2));
}
