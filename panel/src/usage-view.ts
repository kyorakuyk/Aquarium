import type { PanelAccount } from './api.ts';
import { redactSensitiveText } from '../../src/core/impressions/sensitive-text.ts';

export interface UsageAccountLabels {
  primary: string;
  secondary: string;
}

export function usageAccountLabels(account: number | null, accounts: PanelAccount[]): UsageAccountLabels {
  if (account === null) return { primary: '未知', secondary: '旧记录未关联账号' };
  const index = accounts.findIndex((item) => item.account === account);
  if (index < 0) return { primary: `QQ ${account}`, secondary: '当前账号信息不可用' };
  const item = accounts[index];
  if (!item) return { primary: `QQ ${account}`, secondary: '当前账号信息不可用' };
  return {
    primary: index === 0 ? '主' : `第${index + 1}个眷属`,
    secondary: `眷属 ${redactSensitiveText(item.persona)} · ${redactSensitiveText(item.name)}`,
  };
}

export function usageCostLabel(provider: string, costCny: number): string {
  if (/(^|[-_])cli($|[-_])/i.test(provider)) return '—';
  return `¥${costCny.toFixed(2)}`;
}
