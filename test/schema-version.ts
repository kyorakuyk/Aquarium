import { migrations } from '../src/store/migrations/index.ts';

export const CURRENT_SCHEMA_VERSION = migrations.at(-1)?.version ?? 0;
