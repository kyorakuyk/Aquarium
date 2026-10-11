import type { AquariumConfig } from '../config/schema.ts';

export type BudgetState = 'ok' | 'warn' | 'exceeded';

export function budgetState(
  config: Pick<AquariumConfig, 'budget'>,
  costToday: number,
): BudgetState {
  const { dailyCny, warnRatio } = config.budget;
  if (costToday >= dailyCny) return 'exceeded';
  if (costToday >= dailyCny * warnRatio) return 'warn';
  return 'ok';
}
