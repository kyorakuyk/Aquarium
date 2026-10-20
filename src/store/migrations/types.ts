import type { DatabaseSync } from 'node:sqlite';

export interface Migration {
  version: number;
  up(database: DatabaseSync): void;
}
