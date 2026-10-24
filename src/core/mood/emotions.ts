export type MoodRegion = 'unpleasant' | 'oppressed' | 'calm' | 'aroused' | 'excited';

export interface PadEmotion {
  name: string;
  valence: number;
  arousal: number;
  dominance: number;
}

export interface EmotionEdge {
  margin: number;
  dwell: number;
  jump: boolean;
}

export type EmotionEdgeOverrides = Record<string, Record<string, Partial<EmotionEdge>>>;
export type EmotionCoordinateOverrides = Record<string, Omit<PadEmotion, 'name'>>;

export const DEFAULT_SUB_MAX = 2;
export const DEFAULT_SUB_THRESHOLD = 0.5;
export const DEFAULT_CUSTOM_EMOTION_POINT = {
  valence: 0,
  arousal: 0.5,
  dominance: 0,
} as const;

export const DEFAULT_EMOTION_LIBRARY: readonly PadEmotion[] = Object.freeze([
  { name: '兴奋', valence: 0.7, arousal: 0.85, dominance: 0.4 },
  { name: '开心', valence: 0.6, arousal: 0.55, dominance: 0.3 },
  { name: '感动', valence: 0.6, arousal: 0.6, dominance: -0.2 },
  { name: '满足', valence: 0.5, arousal: 0.25, dominance: 0.3 },
  { name: '平静', valence: 0, arousal: 0.3, dominance: 0 },
  { name: '害羞', valence: 0.2, arousal: 0.6, dominance: -0.4 },
  { name: '惊讶', valence: 0, arousal: 0.85, dominance: -0.2 },
  { name: '无聊', valence: -0.2, arousal: 0.1, dominance: 0 },
  { name: '失落', valence: -0.5, arousal: 0.25, dominance: -0.3 },
  { name: '委屈', valence: -0.5, arousal: 0.5, dominance: -0.5 },
  { name: '心疼', valence: -0.3, arousal: 0.5, dominance: -0.1 },
  { name: '吃醋', valence: -0.4, arousal: 0.6, dominance: -0.1 },
  { name: '烦躁', valence: -0.4, arousal: 0.65, dominance: 0.2 },
  { name: '焦虑', valence: -0.4, arousal: 0.75, dominance: -0.5 },
  { name: '害怕', valence: -0.6, arousal: 0.8, dominance: -0.7 },
  { name: '生气', valence: -0.7, arousal: 0.85, dominance: 0.5 },
]);

const NO_JUMP_EDGES = new Set([
  '害羞\u0000生气',
  '满足\u0000害怕',
  '生气\u0000害羞',
]);
const SUB_EMOTION_SIGMA = 0.3;
const MIN_DWELL_SCALE = 0.8;
const DWELL_SCALE_RANGE = 0.6;

export function moodRegionOf(valence: number, arousal: number): MoodRegion {
  if (valence <= -0.15) return arousal >= 0.55 ? 'unpleasant' : 'oppressed';
  if (arousal >= 0.5) return valence < 0.3 ? 'aroused' : 'excited';
  return 'calm';
}

export function padDistance(
  left: Pick<PadEmotion, 'valence' | 'arousal' | 'dominance'>,
  right: Pick<PadEmotion, 'valence' | 'arousal' | 'dominance'>,
): number {
  return Math.hypot(
    left.valence - right.valence,
    (left.arousal - right.arousal) * 1.5,
    (left.dominance - right.dominance) * 0.6,
  );
}

export function emotionIntensity(
  state: Pick<PadEmotion, 'valence' | 'arousal' | 'dominance'>,
  emotion: Pick<PadEmotion, 'valence' | 'arousal' | 'dominance'>,
): number {
  const distance = padDistance(state, emotion);
  return Math.exp(-(distance * distance) / (2 * SUB_EMOTION_SIGMA * SUB_EMOTION_SIGMA));
}

export function defaultEmotionEdge(from: PadEmotion, to: PadEmotion): EmotionEdge {
  const distance = padDistance(from, to);
  return {
    margin: 0.02 + 0.12 * distance,
    dwell: 10,
    jump: !NO_JUMP_EDGES.has(`${from.name}\u0000${to.name}`) && distance < 1.45,
  };
}

export function buildEmotionLibrary(
  emotionNames: readonly string[],
  coordinateOverrides: EmotionCoordinateOverrides = {},
): PadEmotion[] {
  const defaults = new Map(DEFAULT_EMOTION_LIBRARY.map((emotion) => [emotion.name, emotion]));
  const seen = new Set<string>();
  const result: PadEmotion[] = [];
  for (const rawName of emotionNames) {
    const name = rawName.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const base = defaults.get(name);
    result.push({
      name,
      ...(base ?? DEFAULT_CUSTOM_EMOTION_POINT),
      ...coordinateOverrides[name],
    });
  }
  return result;
}

export function dwellMultiplierForMessageId(messageId: string): number {
  if (messageId.length === 0) return 1;
  let hash = 2_166_136_261;
  for (const character of messageId) {
    hash = Math.imul(hash ^ (character.codePointAt(0) ?? 0), 16_777_619) >>> 0;
  }
  return MIN_DWELL_SCALE + (hash / 0xffff_ffff) * DWELL_SCALE_RANGE;
}

export interface ResolveMoodEmotionsInput {
  valence: number;
  arousal: number;
  dominance: number;
  emotions: readonly PadEmotion[];
  edgeOverrides: EmotionEdgeOverrides;
  currentEmotion: string | null;
  emotionSince: number | null;
  lastEmotionChangeAt: number | null;
  now: number;
  messageId: string;
  subMax: number;
  subTh: number;
}

export interface ResolvedMoodEmotions {
  region: MoodRegion;
  mainEmotion: string;
  subEmotions: string[];
  emotionSince: number;
  lastEmotionChangeAt: number | null;
}

export interface ConfiguredMoodSettings {
  emotions: readonly string[];
  coordinates: EmotionCoordinateOverrides;
  edgeOverrides: EmotionEdgeOverrides;
  subMax: number;
  subTh: number;
}

export function resolveConfiguredMoodEmotions(input: {
  state: Pick<PadEmotion, 'valence' | 'arousal' | 'dominance'>;
  settings: ConfiguredMoodSettings;
  currentEmotion: string | null;
  emotionSince: number | null;
  lastEmotionChangeAt: number | null;
  now: number;
  messageId: string;
}): ResolvedMoodEmotions {
  return resolveMoodEmotions({
    ...input.state,
    emotions: buildEmotionLibrary(input.settings.emotions, input.settings.coordinates),
    edgeOverrides: input.settings.edgeOverrides,
    currentEmotion: input.currentEmotion,
    emotionSince: input.emotionSince,
    lastEmotionChangeAt: input.lastEmotionChangeAt,
    now: input.now,
    messageId: input.messageId,
    subMax: input.settings.subMax,
    subTh: input.settings.subTh,
  });
}

export function resolveMoodEmotions(input: ResolveMoodEmotionsInput): ResolvedMoodEmotions {
  if (!Number.isFinite(input.now)) throw new RangeError('情绪切换时间无效');
  if (input.emotions.length === 0) throw new RangeError('人设至少需要一种情绪');
  const unique = input.emotions.filter((emotion, index, all) => (
    emotion.name.trim().length > 0 && all.findIndex((candidate) => candidate.name === emotion.name) === index
  ));
  const state = { valence: input.valence, arousal: input.arousal, dominance: input.dominance };
  const ranked = unique.map((emotion, index) => ({
    emotion,
    index,
    distance: padDistance(state, emotion),
    intensity: emotionIntensity(state, emotion),
  })).sort((left, right) => left.distance - right.distance || left.index - right.index);
  const nearest = ranked[0]!.emotion;
  const current = unique.find((emotion) => emotion.name === input.currentEmotion);
  let mainEmotion = current?.name ?? nearest.name;
  let emotionSince = current && input.emotionSince !== null ? input.emotionSince : input.now;
  let lastEmotionChangeAt = input.lastEmotionChangeAt;

  if (current && nearest.name !== current.name) {
    const base = defaultEmotionEdge(current, nearest);
    const override = input.edgeOverrides[current.name]?.[nearest.name];
    const edge = {
      margin: override?.margin ?? base.margin,
      dwell: override?.dwell ?? base.dwell,
      jump: override?.jump ?? base.jump,
    };
    const improvement = padDistance(state, current) - ranked[0]!.distance;
    const dwellMs = edge.dwell * dwellMultiplierForMessageId(input.messageId) * 60_000;
    if (edge.jump && improvement > edge.margin && input.now - emotionSince >= dwellMs) {
      mainEmotion = nearest.name;
      emotionSince = input.now;
      lastEmotionChangeAt = input.now;
    }
  } else if (!current) {
    lastEmotionChangeAt = input.currentEmotion === null ? input.lastEmotionChangeAt : input.now;
  }

  const main = unique.find((emotion) => emotion.name === mainEmotion) ?? nearest;
  const mainIntensity = emotionIntensity(state, main);
  const subEmotions = unique
    .filter((emotion) => emotion.name !== main.name)
    .map((emotion, index) => ({ emotion, index, intensity: emotionIntensity(state, emotion) }))
    .filter(({ intensity }) => intensity >= mainIntensity * input.subTh)
    .sort((left, right) => right.intensity - left.intensity || left.index - right.index)
    .slice(0, Math.max(0, Math.min(4, Math.trunc(input.subMax))))
    .map(({ emotion }) => emotion.name);

  return {
    region: moodRegionOf(input.valence, input.arousal),
    mainEmotion,
    subEmotions,
    emotionSince,
    lastEmotionChangeAt,
  };
}
