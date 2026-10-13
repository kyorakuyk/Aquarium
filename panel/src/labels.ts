export type DecisionTone = 'positive' | 'neutral' | 'warn';

const decisionLabels: Record<string, string> = {
  replied: '已回复',
  not_mentioned: '没被叫到',
  disabled: '未启用',
  duplicate: '重复消息',
  command_ignored: '指令已忽略',
  rate_limited: '限流',
  muted: '闭嘴中',
  empty_reply: '空回复',
  llm_error: '出错',
  send_error: '出错',
  persona_error: '出错',
  command_error: '出错',
};

const neutralReasons = new Set(['not_mentioned', 'disabled', 'duplicate', 'command_ignored']);
const warningReasons = new Set(['rate_limited', 'muted', 'empty_reply', 'llm_error', 'send_error', 'persona_error', 'command_error']);

export function decisionLabel(reason: string): string {
  const label = Object.hasOwn(decisionLabels, reason) ? decisionLabels[reason] : undefined;
  if (label !== undefined) return label;
  if (reason.startsWith('command_')) return '管理指令';
  return reason;
}

export function decisionTone(reason: string): DecisionTone {
  if (reason === 'replied' || (reason.startsWith('command_') && reason !== 'command_ignored' && reason !== 'command_error')) {
    return 'positive';
  }
  if (warningReasons.has(reason)) return 'warn';
  if (neutralReasons.has(reason)) return 'neutral';
  return 'neutral';
}
