import type { DatabaseSync } from 'node:sqlite';

export interface MigrationContext {
  affinityStart: number;
  affinityTiers: { positive: readonly number[]; negative: readonly number[] };
}

export interface Migration {
  version: number;
  up(database: DatabaseSync, context?: MigrationContext): void;
}
