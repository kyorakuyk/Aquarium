import { z } from 'zod';

const rateSchema = z.object({
  perUserPerMinute: z.number().int().positive(),
  perSessionPerMinute: z.number().int().positive(),
  minIntervalSec: z.number().positive(),
}).strict();

const sessionSettingsSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(['mention_only', 'active', 'natural', 'busy']),
  nicknames: z.array(z.string()),
  contextMessages: z.number().int().positive(),
  rate: rateSchema,
  groupNote: z.string(),
}).strict();

const sessionOverrideSchema = z.object({
  enabled: z.boolean().optional(),
  mode: z.enum(['mention_only', 'active', 'natural', 'busy']).optional(),
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
  defaults: sessionSettingsSchema,
  sessions: z.record(z.string(), sessionOverrideSchema),
  panel: z.object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    passwordEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  }).strict(),
}).strict();

export type AquariumConfig = z.infer<typeof AquariumConfigSchema>;
export type SessionSettings = z.infer<typeof sessionSettingsSchema>;
export type SessionOverride = z.infer<typeof sessionOverrideSchema>;
