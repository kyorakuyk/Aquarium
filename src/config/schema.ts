import { z } from 'zod';
import {
  AffinityCurveCollectionSchema,
  AffinityTiersSchema,
  DEFAULT_AFFINITY_TIERS,
  defaultAffinityCurveSettings,
} from '../persona/affinity.ts';

const rateSchema = z.object({
  perUserPerMinute: z.number().int().positive(),
  perSessionPerMinute: z.number().int().positive(),
  minIntervalSec: z.number().positive(),
}).strict();

const modeSchema = z.enum(['mention_only', 'active', 'natural', 'busy']);
export const ScheduleTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const scheduleTimeSchema = ScheduleTimeSchema;
const modeScheduleEntrySchema = z.object({
  from: scheduleTimeSchema,
  to: scheduleTimeSchema,
  mode: modeSchema,
}).strict().refine((schedule) => schedule.from !== schedule.to, {
  message: '时间段起止时间不能相同',
  path: ['to'],
});
export const ModeScheduleSchema = z.array(modeScheduleEntrySchema);

const sessionSettingsSchema = z.object({
  enabled: z.boolean(),
  mode: modeSchema,
  modeSchedule: ModeScheduleSchema.default([]),
  proactiveCooldownSec: z.number().int().min(0).max(3600).default(120),
  talkOffset: z.number().int().min(-2).max(2).default(0),
  nicknames: z.array(z.string()),
  contextMessages: z.number().int().positive(),
  rate: rateSchema,
  groupNote: z.string(),
}).strict();

const sessionOverrideSchema = z.object({
  enabled: z.boolean().optional(),
  mode: modeSchema.optional(),
  modeSchedule: ModeScheduleSchema.optional(),
  proactiveCooldownSec: z.number().int().min(0).max(3600).optional(),
  talkOffset: z.number().int().min(-2).max(2).optional(),
  nicknames: z.array(z.string()).optional(),
  contextMessages: z.number().int().positive().optional(),
  rate: rateSchema.partial().optional(),
  groupNote: z.string().optional(),
  interactions: z.object({
    react: z.object({
      enabled: z.boolean().optional(),
      prob_scale: z.number().min(0).max(1).optional(),
      per_hour_max: z.number().int().min(1).max(12).optional(),
      per_sender_gap_s: z.number().int().min(60).max(86_400).optional(),
    }).strict().optional(),
    poke: z.object({
      enabled: z.boolean().optional(),
      poke_back: z.boolean().optional(),
      proactive: z.boolean().optional(),
      per_hour_max: z.number().int().min(1).max(6).optional(),
      per_user_gap_s: z.number().int().min(600).max(86_400).optional(),
    }).strict().optional(),
    recall: z.object({
      enabled: z.boolean().optional(),
      self_auto: z.boolean().optional(),
      others: z.boolean().optional(),
    }).strict().optional(),
    admin: z.object({
      enabled: z.boolean().optional(),
      mute_max_s: z.number().int().min(1).max(600).optional(),
      dry_run: z.boolean().optional(),
    }).strict().optional(),
  }).strict().optional(),
}).strict();

const interactionsSchema = z.object({
  master_ids: z.array(z.number().int().positive()).default([]),
  react: z.object({
    enabled: z.boolean().default(false),
    prob_scale: z.number().min(0).max(1).default(1),
    per_hour_max: z.number().int().min(1).max(12).default(12),
    per_sender_gap_s: z.number().int().min(60).max(86_400).default(60),
  }).strict().default({ enabled: false, prob_scale: 1, per_hour_max: 12, per_sender_gap_s: 60 }),
  poke: z.object({
    enabled: z.boolean().default(false),
    poke_back: z.boolean().default(true),
    proactive: z.boolean().default(false),
    per_hour_max: z.number().int().min(1).max(6).default(6),
    per_user_gap_s: z.number().int().min(600).max(86_400).default(600),
  }).strict().default({ enabled: false, poke_back: true, proactive: false, per_hour_max: 6, per_user_gap_s: 600 }),
  recall: z.object({
    enabled: z.boolean().default(false),
    self_auto: z.boolean().default(true),
    others: z.boolean().default(false),
  }).strict().default({ enabled: false, self_auto: true, others: false }),
  admin: z.object({
    enabled: z.boolean().default(false),
    mute_max_s: z.number().int().min(1).max(600).default(600),
    dry_run: z.boolean().default(true),
  }).strict().default({ enabled: false, mute_max_s: 600, dry_run: true }),
}).strict().default({
  master_ids: [],
  react: { enabled: false, prob_scale: 1, per_hour_max: 12, per_sender_gap_s: 60 },
  poke: { enabled: false, poke_back: true, proactive: false, per_hour_max: 6, per_user_gap_s: 600 },
  recall: { enabled: false, self_auto: true, others: false },
  admin: { enabled: false, mute_max_s: 600, dry_run: true },
});

const reservedReasoningFields = new Set([
  'model', 'messages', 'temperature', 'max_tokens', 'max_completion_tokens', 'stream', 'n',
  'tools', 'tool_choice', 'response_format', 'top_p', 'stop', 'seed', 'frequency_penalty',
  'presence_penalty', 'logit_bias', 'user', 'service_tier', 'parallel_tool_calls', 'modalities',
]);
export const ReasoningFieldSchema = z.string().regex(/^[a-z][a-z0-9_]*$/).refine(
  (field) => !reservedReasoningFields.has(field),
  '思考强度字段不能覆盖请求参数',
);

export const ModelParamOverrideSchema = z.object({
  temperature: z.boolean().optional(),
  maxTokens: z.boolean().optional(),
  reasoning: z.boolean().optional(),
}).strict();
export const ProviderModelParamsSchema = z.record(z.string(), ModelParamOverrideSchema);
export const ProviderModelParamsPatchSchema = z.record(z.string(), z.object({
  temperature: z.boolean().nullable().optional(),
  maxTokens: z.boolean().nullable().optional(),
  reasoning: z.boolean().nullable().optional(),
}).strict());

export const ProviderConfigSchema = z.union([
  z.object({
    kind: z.literal('api').default('api'),
    baseUrl: z.string().min(1),
    apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    label: z.string().min(1).optional(),
    reasoningField: ReasoningFieldSchema.default('reasoning_effort'),
    modelParams: ProviderModelParamsSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal('cli'),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    label: z.string().min(1).optional(),
    prewarm: z.boolean().default(false),
    timeoutSec: z.number().int().positive().default(120),
  }).strict(),
]);

export const SlotEntryConfigSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  timeoutSec: z.number().int().min(1).max(3600).optional(),
  reasoning: z.enum(['off', 'low', 'medium', 'high']).default('off'),
}).strict();

const priceSchema = z.object({
  input: z.number().nonnegative(),
  cachedInput: z.number().nonnegative(),
  output: z.number().nonnegative(),
}).strict();

const debugSchema = z.object({
  enabled: z.boolean().default(false),
  sessions: z.record(z.string(), z.boolean()).default({}),
  retainDays: z.number().int().positive().default(7),
}).strict().default({ enabled: false, sessions: {}, retainDays: 7 });

const hostSchema = z.object({
  enabled: z.boolean().default(true),
  startSnowLuma: z.boolean().default(true),
  qqExePath: z.string().default(''),
  scanIntervalSec: z.number().int().positive().default(5),
}).strict().default({
  enabled: true,
  startSnowLuma: true,
  qqExePath: '',
  scanIntervalSec: 5,
});

const sendSchema = z.object({
  dedupeWindowMs: z.number().int().nonnegative().default(8_000),
}).strict().default({ dedupeWindowMs: 8_000 });

const stickersSchema = z.object({
  enabled: z.boolean().default(false),
  maxRatio: z.number().min(0).max(1).default(0.3),
  onlyStickerRatio: z.number().min(0).max(1).default(0.1),
  cooldownSec: z.number().int().min(0).max(86_400).default(300),
  candidates: z.number().int().min(1).max(50).default(8),
}).strict().default({
  enabled: false,
  maxRatio: 0.3,
  onlyStickerRatio: 0.1,
  cooldownSec: 300,
  candidates: 8,
});

const privacySchema = z.object({
  enabled: z.boolean().default(true),
  promoteMentions: z.number().int().min(2).default(3),
  avoidMinutes: z.number().int().positive().default(10),
}).strict().default({
  enabled: true,
  promoteMentions: 3,
  avoidMinutes: 10,
});

const moodSchema = z.preprocess((value: unknown) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const input = value as Record<string, unknown>;
  const legacyHalfLife = input.halfLifeMin;
  const reserve = input.reserve;
  const reserveInput = reserve === undefined
    ? { initial: 0.8 }
    : typeof reserve === 'object' && reserve !== null && !Array.isArray(reserve)
      ? { initial: 0.8, ...(reserve as Record<string, unknown>) }
      : reserve;
  return {
    ...input,
    surfaceHalfLifeMin: input.surfaceHalfLifeMin ?? legacyHalfLife ?? 40,
    arousalHalfLifeMin: input.arousalHalfLifeMin ?? legacyHalfLife ?? 40,
    reserve: reserveInput,
  };
}, z.object({
  enabled: z.boolean().default(true),
  baseline: z.object({
    valence: z.number().min(-1).max(1).default(0.1),
    arousal: z.number().min(0).max(1).default(0.4),
  }).strict().default({ valence: 0.1, arousal: 0.4 }),
  halfLifeMin: z.number().positive().optional(),
  surfaceHalfLifeMin: z.number().positive(),
  arousalHalfLifeMin: z.number().positive(),
  reserve: z.object({ initial: z.number().min(0).max(1) }).strict(),
}).strict().default({
  enabled: true,
  baseline: { valence: 0.1, arousal: 0.4 },
  surfaceHalfLifeMin: 40,
  arousalHalfLifeMin: 40,
  reserve: { initial: 0.8 },
}));

const defaultAffinityCurves = defaultAffinityCurveSettings();
const affinityCurveDefaultsSchema = AffinityCurveCollectionSchema.default(defaultAffinityCurves);

const affinitySchema = z.preprocess((value: unknown) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const input = value as Record<string, unknown>;
  const { initial, ...current } = input;
  if (current.start !== undefined || typeof initial !== 'number') return current;
  return {
    ...current,
    start: initial === 50 ? 15 : (initial - 50) * 2,
  };
}, z.object({
  enabled: z.boolean().default(true),
  start: z.number().min(-100).max(100).default(15),
  tiers: AffinityTiersSchema.default({
    positive: [...DEFAULT_AFFINITY_TIERS.positive],
    negative: [...DEFAULT_AFFINITY_TIERS.negative],
  }),
  curveDefaults: affinityCurveDefaultsSchema,
}).strict().default({
  enabled: true,
  start: 15,
  tiers: { positive: [15, 35, 60, 85], negative: [-85, -60, -35, -15] },
  curveDefaults: defaultAffinityCurves,
}));

const sleepSchema = z.object({
  enabled: z.boolean().default(false),
  bedtime: scheduleTimeSchema.default('02:00'),
  wake: scheduleTimeSchema.default('09:00'),
  wakeWords: z.array(z.string().min(1)).default(['起床', '醒醒', '别睡了']),
  goodnight: z.boolean().default(true),
}).strict().default({
  enabled: false,
  bedtime: '02:00',
  wake: '09:00',
  wakeWords: ['起床', '醒醒', '别睡了'],
  goodnight: true,
});

const profileScheduleSchema = z.object({
  minimumMessages: z.number().int().positive().default(50),
  nightOwlRatio: z.number().min(0).max(1).default(0.4),
  weekendActiveRatio: z.number().positive().default(1.5),
  morningRatio: z.number().min(0).max(1).default(0.03),
  morningMinimumMessages: z.number().int().positive().default(100),
}).strict().default({
  minimumMessages: 50,
  nightOwlRatio: 0.4,
  weekendActiveRatio: 1.5,
  morningRatio: 0.03,
  morningMinimumMessages: 100,
});

const profileSchema = z.object({
  schedule: profileScheduleSchema,
}).strict().default({
  schedule: {
    minimumMessages: 50,
    nightOwlRatio: 0.4,
    weekendActiveRatio: 1.5,
    morningRatio: 0.03,
    morningMinimumMessages: 100,
  },
});

export const AquariumConfigSchema = z.object({
  owner: z.number().int().nonnegative(),
  accounts: z.array(z.object({
    uin: z.number().int().positive(),
    persona: z.string().min(1),
    snowlumaDir: z.string().min(1),
  }).strict()),
  providers: z.record(z.string(), ProviderConfigSchema),
  slots: z.record(z.string(), z.array(SlotEntryConfigSchema).min(1)),
  pricing: z.record(z.string(), priceSchema),
  budget: z.object({
    dailyCny: z.number().nonnegative(),
    warnRatio: z.number().min(0).max(1),
  }).strict(),
  mood: moodSchema,
  affinity: affinitySchema,
  sleep: sleepSchema,
  profile: profileSchema,
  defaults: sessionSettingsSchema,
  sessions: z.record(z.string(), sessionOverrideSchema),
  debug: debugSchema,
  host: hostSchema,
  send: sendSchema,
  stickers: stickersSchema,
  privacy: privacySchema,
  interactions: interactionsSchema,
  panel: z.object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    passwordEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  }).strict(),
}).strict();

export type AquariumConfig = z.infer<typeof AquariumConfigSchema>;
export type SessionSettings = z.infer<typeof sessionSettingsSchema>;
export type SessionOverride = z.infer<typeof sessionOverrideSchema>;
