import type { AquariumConfig } from '../config/schema.ts';

export type BudgetState = 'ok' | 'warn' | 'exceeded';
export type BudgetScope = 'daily' | 'oneoff';

export class BudgetExceededError extends Error {
  readonly code = 'BUDGET_EXCEEDED';
  readonly slot: string;
  readonly scope: BudgetScope;
  readonly usedCny: number;
  readonly limitCny: number;

  constructor(
    slot: string,
    scope: BudgetScope,
    usedCny: number,
    limitCny: number,
  ) {
    super(`${scope === 'daily' ? '每日' : '单任务'}预算已用尽：${slot}`);
    this.name = 'BudgetExceededError';
    this.slot = slot;
    this.scope = scope;
    this.usedCny = usedCny;
    this.limitCny = limitCny;
  }
}

export function isBudgetExceededError(error: unknown): error is BudgetExceededError {
  if (error instanceof BudgetExceededError) return true;
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === 'BudgetExceededError' && candidate.code === 'BUDGET_EXCEEDED';
}

export function budgetState(
  config: Pick<AquariumConfig, 'budget'>,
  costToday: number,
): BudgetState {
  const { dailyCny, warnRatio } = config.budget;
  if (costToday >= dailyCny) return 'exceeded';
  if (costToday >= dailyCny * warnRatio) return 'warn';
  return 'ok';
}

function isNonBillableEntry(config: AquariumConfig, entry: AquariumConfig['slots'][string][number]): boolean {
  const provider = config.providers[entry.provider];
  if (provider?.kind === 'cli') return true;
  const price = config.pricing[entry.model];
  return price !== undefined
    && price.input === 0
    && price.cachedInput === 0
    && price.output === 0;
}

function hasNonBillableEntry(config: AquariumConfig, slot: string): boolean {
  return (config.slots[slot] ?? []).some((entry) => isNonBillableEntry(config, entry));
}

export function canCallWithDailyBudget(
  config: AquariumConfig,
  slot: string,
  costToday: number,
): boolean {
  return budgetState(config, costToday) !== 'exceeded' || hasNonBillableEntry(config, slot);
}

export function filterNonBillableEntries(config: AquariumConfig, slot: string): AquariumConfig['slots'][string] {
  return (config.slots[slot] ?? []).filter((entry) => isNonBillableEntry(config, entry));
}
