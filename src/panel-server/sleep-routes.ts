import { Hono } from 'hono';
import { z } from 'zod';
import type { AquariumConfig } from '../config/schema.ts';
import { AquariumConfigSchema, ScheduleTimeSchema } from '../config/schema.ts';
import type { SleepWakeState } from '../core/sleep.ts';
import { sleepEnergy, sleepPlan } from '../core/sleep.ts';
import type { StoreRepository } from '../store/repository.ts';

const sleepPatchSchema = z.object({
  enabled: z.boolean().optional(),
  bedtime: ScheduleTimeSchema.optional(),
  wake: ScheduleTimeSchema.optional(),
  goodnight: z.boolean().optional(),
}).strict();

export interface SleepRouteOptions {
  getConfig: () => AquariumConfig;
  saveConfig: (config: AquariumConfig) => void | Promise<void>;
  repository: StoreRepository;
  account: () => number | null;
  sleepWakeState?: SleepWakeState;
  now: () => number;
  serializeConfigWrite: <T>(task: () => Promise<T>) => Promise<T>;
}

export function registerSleepRoutes(app: Hono, options: SleepRouteOptions): void {
  app.get('/api/sleep', (context) => {
    const config = options.getConfig();
    const now = options.now();
    const plan = sleepPlan(now, config.sleep.bedtime, config.sleep.wake);
    const woken = config.sleep.enabled && plan.asleep && (options.sleepWakeState?.isAwake(now) ?? false);
    const status = !config.sleep.enabled ? 'awake' : woken ? 'woken' : plan.asleep ? 'asleep' : 'awake';
    const account = options.account();
    const replyCount = account === null ? 0 : options.repository.replyCountLastHourForAccount(account, now);
    const energy = !config.sleep.enabled
      ? 1
      : status === 'asleep' ? null : sleepEnergy(now, plan.wakeAt, plan.bedAt, replyCount, true);
    const nextChangeAt = !config.sleep.enabled
      ? null
      : status === 'asleep'
        ? plan.wakeAt
        : status === 'woken'
          ? options.sleepWakeState?.activeUntil(now) ?? plan.wakeAt
          : plan.bedAt;
    return context.json({
      ...config.sleep,
      status,
      energy,
      nextChangeAt,
      cycleKey: plan.cycleKey,
      account,
    });
  });

  app.patch('/api/sleep', async (context) => {
    let rawBody: unknown;
    try { rawBody = await context.req.json(); } catch { return context.json({ error: 'Invalid JSON' }, 400); }
    const parsedPatch = sleepPatchSchema.safeParse(rawBody);
    if (!parsedPatch.success) return context.json({ error: 'Invalid sleep patch' }, 400);

    return options.serializeConfigWrite(async () => {
      const config = options.getConfig();
      const nextConfig = AquariumConfigSchema.safeParse({
        ...config,
        sleep: { ...config.sleep, ...parsedPatch.data },
      });
      if (!nextConfig.success) return context.json({ error: 'Invalid sleep configuration' }, 400);
      await options.saveConfig(nextConfig.data);
      return context.json(nextConfig.data.sleep);
    });
  });
}
