import type { DatabaseSync } from 'node:sqlite';

export interface RecentExtractUsageRepository {
  recentExtractAverageCost(): number | undefined;
}

export function createRecentExtractUsageQueries(database: DatabaseSync): RecentExtractUsageRepository {
  const selectRecentExtractCosts = database.prepare(`
    SELECT cost_cny
    FROM usage
    WHERE slot = 'extract'
    ORDER BY time DESC, id DESC
    LIMIT 30
  `);
  return {
    recentExtractAverageCost() {
      const rows = selectRecentExtractCosts.all() as Array<{ cost_cny: unknown }>;
      if (rows.length === 0) return undefined;
      const total = rows.reduce((sum, row) => {
        if (typeof row.cost_cny === 'number' && Number.isFinite(row.cost_cny)) return sum + row.cost_cny;
        if (typeof row.cost_cny === 'bigint') return sum + Number(row.cost_cny);
        throw new Error('数据库字段 cost_cny 不是数字');
      }, 0);
      return total / rows.length;
    },
  };
}
