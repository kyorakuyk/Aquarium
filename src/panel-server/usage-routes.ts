import type { Hono } from 'hono';
import type { AquariumConfig } from '../config/schema.ts';
import type { StoreRepository, UsageRange } from '../store/repository.ts';

export interface UsageRouteOptions {
  getConfig: () => AquariumConfig;
  repository: StoreRepository;
  now?: () => number;
}

function isUsageRange(value: string): value is UsageRange {
  return value === 'today' || value === '7d' || value === '30d';
}

export function registerUsageRoutes(app: Hono, options: UsageRouteOptions): void {
  const now = options.now ?? Date.now;
  app.get('/api/usage', (context) => {
    const range = context.req.query('range') ?? 'today';
    if (!isUsageRange(range)) return context.json({ error: 'Invalid usage range' }, 400);

    const report = options.repository.usageByRange(range, now());
    return context.json({
      totals: {
        ...report.totals,
        budgetToday: {
          used: options.repository.costToday(),
          limit: options.getConfig().budget.dailyCny,
        },
      },
      rows: report.rows,
    });
  });
}
