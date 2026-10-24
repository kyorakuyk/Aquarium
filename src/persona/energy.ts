import { z } from 'zod';

const multiplier = z.number().min(0).max(3);

export const PersonaEnergySchema = z.object({
  aloneRecovery: multiplier.default(1),
  companyRecovery: multiplier.default(1),
  warmCharge: multiplier.default(1),
  bufferCost: multiplier.default(1),
  calmRecoveryCost: multiplier.default(1),
  hurtCost: multiplier.default(1),
  senderHourlyCap: multiplier.default(1),
}).strict();

export type PersonaEnergyMultipliers = z.infer<typeof PersonaEnergySchema>;

export const DEFAULT_PERSONA_ENERGY: PersonaEnergyMultipliers = PersonaEnergySchema.parse({});

export function resolveEnergyMultiplier(
  settings: Partial<PersonaEnergyMultipliers> | undefined,
  key: keyof PersonaEnergyMultipliers,
): number {
  const value = settings?.[key] ?? 1;
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(3, value))
    : 1;
}

export function parsePersonaEnergy(value: unknown): PersonaEnergyMultipliers {
  const parsed = PersonaEnergySchema.safeParse(value ?? {});
  if (parsed.success) return parsed.data;
  const detail = parsed.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? `.${issue.path.join('.')}` : '';
    return `${path} ${issue.message}`.trim();
  }).join('; ');
  throw new Error(`人设字段 energy 无效：${detail}`);
}
