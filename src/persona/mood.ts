import { z } from 'zod';
import {
  DEFAULT_CUSTOM_EMOTION_POINT,
  DEFAULT_EMOTION_LIBRARY,
  DEFAULT_SUB_MAX,
  DEFAULT_SUB_THRESHOLD,
  buildEmotionLibrary,
  defaultEmotionEdge,
  type EmotionCoordinateOverrides,
  type EmotionEdgeOverrides,
} from '../core/mood/emotions.ts';

const coordinateSchema = z.object({
  valence: z.number().min(-1).max(1),
  arousal: z.number().min(0).max(1),
  dominance: z.number().min(-1).max(1),
}).strict();

const edgeOverrideSchema = z.object({
  margin: z.number().min(0).max(0.5).optional(),
  dwell: z.number().min(0).max(60).optional(),
  jump: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, '至少设置一项边覆盖');

export const PersonaMoodSchema = z.object({
  emotions: z.array(z.string().trim().min(1).max(32)).min(1).max(64)
    .default(DEFAULT_EMOTION_LIBRARY.map((emotion) => emotion.name)),
  coordinates: z.record(z.string().min(1), coordinateSchema).default({}),
  edgeOverrides: z.record(z.string().min(1), z.record(z.string().min(1), edgeOverrideSchema)).default({}),
  subMax: z.number().int().min(0).max(4).default(DEFAULT_SUB_MAX),
  subTh: z.number().min(0.2).max(0.9).default(DEFAULT_SUB_THRESHOLD),
  surfaceHoldShape: z.number().min(1).max(6).optional(),
  arousalHoldShape: z.number().min(1).max(6).optional(),
}).strict().superRefine((value, context) => {
  const names = new Set<string>();
  for (const [index, name] of value.emotions.entries()) {
    if (names.has(name)) {
      context.addIssue({ code: 'custom', path: ['emotions', index], message: '情绪名称不能重复' });
    }
    names.add(name);
  }
  for (const name of Object.keys(value.coordinates)) {
    if (!names.has(name)) {
      context.addIssue({ code: 'custom', path: ['coordinates', name], message: '坐标覆盖必须对应已选情绪' });
    }
  }
  for (const [from, destinations] of Object.entries(value.edgeOverrides)) {
    if (!names.has(from)) {
      context.addIssue({ code: 'custom', path: ['edgeOverrides', from], message: '切换来源必须是已选情绪' });
    }
    for (const to of Object.keys(destinations)) {
      if (!names.has(to) || to === from) {
        context.addIssue({ code: 'custom', path: ['edgeOverrides', from, to], message: '切换目标必须是另一个已选情绪' });
      }
    }
  }
});

export type PersonaMoodSettings = z.infer<typeof PersonaMoodSchema>;
export type PersonaMoodOverrides = Partial<PersonaMoodSettings>;

export const DEFAULT_PERSONA_MOOD: PersonaMoodSettings = PersonaMoodSchema.parse({});

export function parsePersonaMood(value: unknown): PersonaMoodSettings {
  const parsed = PersonaMoodSchema.safeParse(value === undefined ? {} : value);
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? `.${issue.path.join('.')}` : '';
    return `${path} ${issue.message}`.trim();
  }).join('; ');
  throw new Error(`人设字段 mood 无效：${detail}`);
}

function sameCoordinate(
  left: { valence: number; arousal: number; dominance: number },
  right: { valence: number; arousal: number; dominance: number },
): boolean {
  return Math.abs(left.valence - right.valence) < 1e-9
    && Math.abs(left.arousal - right.arousal) < 1e-9
    && Math.abs(left.dominance - right.dominance) < 1e-9;
}

export function serializePersonaMood(settings: PersonaMoodSettings): PersonaMoodOverrides | undefined {
  const names = settings.emotions;
  const defaultNames = DEFAULT_EMOTION_LIBRARY.map((emotion) => emotion.name);
  const result: PersonaMoodOverrides = {};
  if (names.length !== defaultNames.length || names.some((name, index) => name !== defaultNames[index])) {
    result.emotions = [...names];
  }

  const coordinates: EmotionCoordinateOverrides = {};
  const library = buildEmotionLibrary(names, settings.coordinates);
  for (const emotion of library) {
    const coordinate = settings.coordinates[emotion.name];
    if (!coordinate) continue;
    const defaultEmotion = DEFAULT_EMOTION_LIBRARY.find((candidate) => candidate.name === emotion.name);
    const defaultPoint = defaultEmotion ?? DEFAULT_CUSTOM_EMOTION_POINT;
    if (!sameCoordinate(coordinate, defaultPoint)) coordinates[emotion.name] = { ...coordinate };
  }
  if (Object.keys(coordinates).length > 0) result.coordinates = coordinates;

  const resolved = new Map(library.map((emotion) => [emotion.name, emotion]));
  const edgeOverrides: EmotionEdgeOverrides = {};
  for (const [from, destinations] of Object.entries(settings.edgeOverrides)) {
    const source = resolved.get(from);
    if (!source) continue;
    for (const [to, override] of Object.entries(destinations)) {
      const target = resolved.get(to);
      if (!target) continue;
      const defaults = defaultEmotionEdge(source, target);
      const reduced: Partial<typeof defaults> = {};
      if (override.margin !== undefined && Math.abs(override.margin - defaults.margin) >= 1e-9) reduced.margin = override.margin;
      if (override.dwell !== undefined && override.dwell !== defaults.dwell) reduced.dwell = override.dwell;
      if (override.jump !== undefined && override.jump !== defaults.jump) reduced.jump = override.jump;
      if (Object.keys(reduced).length > 0) {
        edgeOverrides[from] ??= {};
        edgeOverrides[from]![to] = reduced;
      }
    }
  }
  if (Object.keys(edgeOverrides).length > 0) result.edgeOverrides = edgeOverrides;
  if (settings.subMax !== DEFAULT_SUB_MAX) result.subMax = settings.subMax;
  if (Math.abs(settings.subTh - DEFAULT_SUB_THRESHOLD) >= 1e-9) result.subTh = settings.subTh;
  if (settings.surfaceHoldShape !== undefined) result.surfaceHoldShape = settings.surfaceHoldShape;
  if (settings.arousalHoldShape !== undefined) result.arousalHoldShape = settings.arousalHoldShape;
  return Object.keys(result).length > 0 ? result : undefined;
}
