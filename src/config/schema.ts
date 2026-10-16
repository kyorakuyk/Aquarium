import { z } from 'zod';

const rateSchema = z.object({
  perUserPerMinute: z.number().int().positive(),
  perSessionPerMinute: z.number().int().positive(),
  minIntervalSec: z.number().positive(),
}).strict();

const modeSchema = z.enum(['mention_only', 'active', 'natural', 'busy']);
const scheduleTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
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
  nicknames: z.array(z.string()),
  contextMessages: z.number().int().positive(),
  rate: rateSchema,
  groupNote: z.string(),
}).strict();

const sessionOverrideSchema = z.object({
  enabled: z.boolean().optional(),
  mode: modeSchema.optional(),
  modeSchedule: ModeScheduleSchema.optional(),
  nicknames: z.array(z.string()).optional(),
  contextMessages: z.number().int().positive().optional(),
  rate: rateSchema.partial().optional(),
  groupNote: z.string().optional(),
}).strict();

const providerSchema = z.object({
  baseUrl: z.string().min(1),
  apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
}).strict();

const slotEntrySchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
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

export const AquariumConfigSchema = z.object({
  owner: z.number().int().nonnegative(),
  accounts: z.array(z.object({
    uin: z.number().int().positive(),
    persona: z.string().min(1),
    snowlumaDir: z.string().min(1),
  }).strict()),
  providers: z.record(z.string(), providerSchema),
  slots: z.record(z.string(), z.array(slotEntrySchema).min(1)),
  pricing: z.record(z.string(), priceSchema),
  budget: z.object({
    dailyCny: z.number().nonnegative(),
    warnRatio: z.number().min(0).max(1),
  }).strict(),
  mood: moodSchema,
  defaults: sessionSettingsSchema,
  sessions: z.record(z.string(), sessionOverrideSchema),
  debug: debugSchema,
  host: hostSchema,
  panel: z.object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    passwordEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  }).strict(),
}).strict();

export type AquariumConfig = z.infer<typeof AquariumConfigSchema>;
export type SessionSettings = z.infer<typeof sessionSettingsSchema>;
export type SessionOverride = z.infer<typeof sessionOverrideSchema>;
