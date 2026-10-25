import { z } from 'zod';
import type { SelfEditScope } from '../../config/schema.ts';

const changeInputSchema = z.object({
  key: z.string().min(1).max(100),
  op: z.enum(['set', 'add', 'remove']),
  value: z.unknown(),
}).strict();

export const SelfEditActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('read'), key: z.string().min(1).max(100) }).strict(),
  z.object({
    action: z.literal('propose'),
    changes: z.array(changeInputSchema).min(1).max(8),
    say: z.string().min(1).max(400),
  }).strict(),
  z.object({ action: z.literal('ask'), say: z.string().min(1).max(400) }).strict(),
  z.object({ action: z.literal('refuse'), say: z.string().min(1).max(400) }).strict(),
]);

export type SelfEditChangeInput = z.infer<typeof changeInputSchema>;
export type SelfEditAction = z.infer<typeof SelfEditActionSchema>;

export interface SelfEditKeyDefinition {
  key: string;
  label: string;
  scope: SelfEditScope;
  target: 'persona' | 'config' | 'session';
  kind: 'text' | 'list' | 'trait' | 'time' | 'integer' | 'ratio' | 'boolean' | 'mute';
}

const personaKeys: SelfEditKeyDefinition[] = [
  { key: 'persona.身份', label: '身份', scope: 'persona_behavior', target: 'persona', kind: 'text' },
  { key: 'persona.年龄', label: '年龄', scope: 'persona_behavior', target: 'persona', kind: 'text' },
  { key: 'persona.背景', label: '背景', scope: 'persona_behavior', target: 'persona', kind: 'text' },
  { key: 'persona.说话方式', label: '说话方式', scope: 'persona_behavior', target: 'persona', kind: 'text' },
  { key: 'persona.口头禅', label: '口头禅', scope: 'persona_behavior', target: 'persona', kind: 'list' },
  { key: 'persona.常用表情', label: '常用表情', scope: 'persona_behavior', target: 'persona', kind: 'list' },
  { key: 'persona.对熟人', label: '对熟人', scope: 'persona_behavior', target: 'persona', kind: 'text' },
  { key: 'persona.对陌生人', label: '对陌生人', scope: 'persona_behavior', target: 'persona', kind: 'text' },
  { key: 'persona.对主人', label: '对主人', scope: 'persona_behavior', target: 'persona', kind: 'text' },
  { key: 'persona.底线', label: '底线', scope: 'persona_boundaries', target: 'persona', kind: 'list' },
  ...(['order', 'morality', 'talk', 'mind', 'humor', 'openness', 'imitation'] as const)
    .map((trait) => ({
      key: `persona.traits.${trait}`,
      label: `性格.${trait}`,
      scope: 'persona_traits' as const,
      target: 'persona' as const,
      kind: 'trait' as const,
    })),
];

const otherKeys: SelfEditKeyDefinition[] = [
  { key: 'behavior.sleep.bedtime', label: '作息.就寝时间', scope: 'behavior', target: 'config', kind: 'time' },
  { key: 'behavior.sleep.wake', label: '作息.起床时间', scope: 'behavior', target: 'config', kind: 'time' },
  { key: 'behavior.proactiveCooldownSec', label: '主动搭话间隔秒', scope: 'behavior', target: 'config', kind: 'integer' },
  { key: 'behavior.stickers.enabled', label: '贴表情开关', scope: 'behavior', target: 'config', kind: 'boolean' },
  { key: 'behavior.stickers.maxRatio', label: '表情包发送频率上限', scope: 'behavior', target: 'config', kind: 'ratio' },
  { key: 'session.muteMinutes', label: '本群闭嘴分钟', scope: 'session', target: 'session', kind: 'mute' },
];

export const SELF_EDIT_KEYS = [...personaKeys, ...otherKeys] as const;
const definitions = new Map<string, SelfEditKeyDefinition>(SELF_EDIT_KEYS.map((entry) => [entry.key, entry]));

export function selfEditKey(key: string): SelfEditKeyDefinition | undefined {
  return definitions.get(key);
}

export function selfEditKeysForScopes(scopes: readonly SelfEditScope[]): SelfEditKeyDefinition[] {
  const enabled = new Set(scopes);
  return SELF_EDIT_KEYS.filter((entry) => enabled.has(entry.scope));
}
