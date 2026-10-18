import type { ModelProviderView, ModelReasoning, ModelSlotEntryView } from './api.ts';

export interface SlotDef {
  slot: string;
  title: string;
  description: string;
}

export const MODEL_SLOT_DEFS: SlotDef[] = [
  { slot: 'reply', title: '回复', description: '群聊和私聊的发言' },
  { slot: 'judge', title: '主动判断', description: '要不要接话' },
  { slot: 'extract', title: '提取与评估', description: '印象标签、情绪评估' },
  { slot: 'vision', title: '看图', description: '图片转文字' },
];

export const REASONING_OPTIONS: Array<{ value: ModelReasoning; label: string }> = [
  { value: 'off', label: '关' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
];

export function reasoningLabel(value: ModelReasoning | undefined): string {
  return REASONING_OPTIONS.find((option) => option.value === (value ?? 'off'))?.label ?? '关';
}

export function providerName(providerId: string, providers: ModelProviderView[]): string {
  return providers.find((provider) => provider.id === providerId)?.label ?? providerId;
}

export function chainSummary(chain: ModelSlotEntryView[] | undefined, providers: ModelProviderView[]): string {
  if (!chain || chain.length === 0) return '未配置';
  return chain.map((entry) => `${providerName(entry.provider, providers)} · ${entry.model}`).join(' → ');
}

export function runtimeLabel(provider: ModelProviderView): string {
  const runtime = provider.runtime;
  if (!runtime) return '';
  const state = runtime.state === 'ready'
    ? provider.prewarm ? '常驻待命' : '空闲'
    : runtime.state === 'starting' ? '启动中'
      : runtime.state === 'busy' ? '处理中'
        : runtime.state === 'restarting' ? '重启中'
          : '已停止';
  const details = [
    runtime.state === 'stopped' ? '仅单次调用' : '',
    runtime.pid ? `pid ${runtime.pid}` : '',
    runtime.served > 0 ? `已处理 ${runtime.served} 次` : '',
  ].filter(Boolean);
  return [state, ...details].join(' · ');
}

export function providerStatus(provider: ModelProviderView): { tone: 'ok' | 'warn' | 'muted'; text: string } {
  if (provider.kind === 'api') {
    return provider.keyStatus.set
      ? { tone: 'ok', text: `密钥 ••••${provider.keyStatus.last4}` }
      : { tone: 'warn', text: '未配置密钥' };
  }
  const runtime = provider.runtime;
  if (!runtime || runtime.state === 'stopped') return { tone: 'muted', text: '仅单次调用' };
  if (runtime.state === 'restarting') return { tone: 'warn', text: runtimeLabel(provider) };
  return { tone: 'ok', text: runtimeLabel(provider) };
}

export function providerMeta(provider: ModelProviderView): string {
  if (provider.kind === 'api') return provider.baseUrl ?? '';
  const args = provider.args && provider.args.length > 0 ? ` ${provider.args.join(' ')}` : '';
  return `${provider.command ?? ''}${args}`;
}
