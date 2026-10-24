import { z } from 'zod';

export const AFFINITY_CURVE_IDS = ['posGain', 'posLoss', 'negGain', 'negLoss'] as const;
export type AffinityCurveId = typeof AFFINITY_CURVE_IDS[number];
export type AffinityCurvePreset = 'default' | 'flat' | 'slow';

export const DEFAULT_AFFINITY_TIERS = {
  positive: [15, 35, 60, 85],
  negative: [-85, -60, -35, -15],
} as const;

export const DEFAULT_AFFINITY_CURVE = { preset: 'default', points: [] } as const;

const curvePointSchema = z.object({
  x: z.number().min(0).max(1),
  dy: z.number().min(-3).max(3),
}).strict();

export const AffinityCurveSchema = z.object({
  preset: z.enum(['default', 'flat', 'slow']).default('default'),
  points: z.array(curvePointSchema).max(64).default([]),
}).strict();

export const AffinityCurveOverridesSchema = z.object({
  posGain: AffinityCurveSchema.optional(),
  posLoss: AffinityCurveSchema.optional(),
  negGain: AffinityCurveSchema.optional(),
  negLoss: AffinityCurveSchema.optional(),
}).strict();

export const AffinityTiersSchema = z.object({
  positive: z.array(z.number().min(0).max(100)).length(4),
  negative: z.array(z.number().min(-100).max(0)).length(4),
}).strict().superRefine((tiers, context) => {
  for (const direction of ['positive', 'negative'] as const) {
    const values = tiers[direction];
    for (let index = 1; index < values.length; index += 1) {
      if ((values[index] ?? 0) - (values[index - 1] ?? 0) < 3) {
        context.addIssue({
          code: 'custom',
          path: [direction, index],
          message: '相邻好感分界至少间隔 3',
        });
      }
    }
  }
});

export const AffinityCurveCollectionSchema = z.object({
  posGain: AffinityCurveSchema,
  posLoss: AffinityCurveSchema,
  negGain: AffinityCurveSchema,
  negLoss: AffinityCurveSchema,
}).strict();

export const PersonaAffinitySchema = z.object({
  mode: z.enum(['inherit', 'independent']).default('inherit'),
  tiers: AffinityTiersSchema.optional(),
  curves: AffinityCurveOverridesSchema.optional(),
}).strict();

export type AffinityCurve = z.infer<typeof AffinityCurveSchema>;
export type AffinityCurveOverrides = z.infer<typeof AffinityCurveOverridesSchema>;
export type PersonaAffinitySettings = z.infer<typeof PersonaAffinitySchema>;

export function defaultAffinityCurveSettings(): Record<AffinityCurveId, AffinityCurve> {
  return {
    posGain: { preset: 'default', points: [] },
    posLoss: { preset: 'default', points: [] },
    negGain: { preset: 'default', points: [] },
    negLoss: { preset: 'default', points: [] },
  };
}

export function parsePersonaAffinity(value: unknown): PersonaAffinitySettings {
  const parsed = PersonaAffinitySchema.safeParse(value ?? {});
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? `.${issue.path.join('.')}` : '';
    return `${path} ${issue.message}`.trim();
  }).join('; ');
  throw new Error(`人设好感字段 affinity 无效：${detail}`);
}
