import { z } from 'zod';

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
}).strict();

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

const moodSchema = z.object({
  enabled: z.boolean().default(true),
  baseline: z.object({
    valence: z.number().min(-1).max(1).default(0.1),
    arousal: z.number().min(0).max(1).default(0.4),
  }).strict().default({ valence: 0.1, arousal: 0.4 }),
  halfLifeMin: z.number().positive().default(30),
}).strict().default({
  enabled: true,
  baseline: { valence: 0.1, arousal: 0.4 },
  halfLifeMin: 30,
});

const affinitySchema = z.object({
  enabled: z.boolean().default(true),
  initial: z.number().min(0).max(100).default(50),
}).strict().default({ enabled: true, initial: 50 });

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
  defaults: sessionSettingsSchema,
  sessions: z.record(z.string(), sessionOverrideSchema),
  debug: debugSchema,
  host: hostSchema,
  send: sendSchema,
  panel: z.object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    passwordEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  }).strict(),
}).strict();

export type AquariumConfig = z.infer<typeof AquariumConfigSchema>;
export type SessionSettings = z.infer<typeof sessionSettingsSchema>;
export type SessionOverride = z.infer<typeof sessionOverrideSchema>;
