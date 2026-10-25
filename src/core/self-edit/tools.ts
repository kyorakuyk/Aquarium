import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { AquariumConfigSchema, type AquariumConfig } from '../../config/schema.ts';
import type { SessionKey } from '../shared/events.ts';
import { parseSections, buildSections, type PersonaSectionHeading } from '../../persona/sections.ts';
import type { PersonaTraits } from '../../persona/load.ts';
import { validPersonaId } from '../../persona/persona-id.ts';
import { selfEditKey, type SelfEditChangeInput, type SelfEditKeyDefinition } from './registry.ts';

export interface SelfEditMuteState {
  getUntil(session: SessionKey): number | undefined;
  setUntil(session: SessionKey, until: number | undefined): void;
}

export interface SelfEditContext {
  config: AquariumConfig;
  root: string;
  session: SessionKey;
  muteState: SelfEditMuteState;
  now: number;
}

export interface PreparedSelfEditChange {
  key: string;
  label: string;
  target: SelfEditKeyDefinition['target'];
  operation: 'set' | 'add' | 'remove' | 'restore';
  before: unknown;
  after: unknown;
}

const personaTextSchema = z.string().trim().min(1).max(1_200);
const listItemSchema = z.string().trim().min(1).max(120);
const listSchema = z.array(listItemSchema).max(30).refine(
  (items) => new Set(items).size === items.length,
  '列表中不能有重复项',
);
const traitSchema = z.number().finite().min(-2).max(2);
const timeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u);

function personaPath(root: string, id: string): string {
  if (!validPersonaId(id.toLowerCase())) throw new Error('当前人设 ID 无效，拒绝修改。');
  return join(root, 'data', 'personas', `${id}.md`);
}

export function selectedPersonaId(config: AquariumConfig, account: number): string {
  const accountConfig = config.accounts.find((entry) => entry.uin === account);
  if (!accountConfig) throw new Error('找不到当前账号的人设绑定。');
  return accountConfig.persona;
}

export function readPersonaSource(root: string, personaId: string): { path: string; source: string; existed: boolean } {
  const userPath = personaPath(root, personaId);
  if (existsSync(userPath)) return { path: userPath, source: readFileSync(userPath, 'utf8'), existed: true };
  const builtinPath = join(root, 'personas', `${personaId}.md`);
  if (!existsSync(builtinPath)) throw new Error('找不到当前人设文件。');
  return { path: userPath, source: readFileSync(builtinPath, 'utf8'), existed: false };
}

function personaFieldValue(source: string, key: string): unknown {
  const form = parseSections(source);
  if (key.startsWith('persona.traits.')) {
    const trait = key.slice('persona.traits.'.length) as keyof PersonaTraits;
    return form.traits[trait];
  }
  const field = key.slice('persona.'.length) as PersonaSectionHeading;
  return form.fields[field];
}

export function readSelfEditValue(key: string, context: SelfEditContext): unknown {
  const definition = selfEditKey(key);
  if (!definition) throw new Error('这项设置不在可修改范围内。');
  if (definition.target === 'persona') {
    const id = selectedPersonaId(context.config, context.session.account);
    const { source } = readPersonaSource(context.root, id);
    return personaFieldValue(source, key);
  }
  if (definition.target === 'session') {
    const until = context.muteState.getUntil(context.session);
    return until !== undefined && until > context.now
      ? { muted: true, remainingMinutes: Math.max(1, Math.ceil((until - context.now) / 60_000)) }
      : { muted: false, remainingMinutes: 0 };
  }
  switch (key) {
    case 'behavior.sleep.bedtime': return context.config.sleep.bedtime;
    case 'behavior.sleep.wake': return context.config.sleep.wake;
    case 'behavior.proactiveCooldownSec': return context.config.defaults.proactiveCooldownSec;
    case 'behavior.stickers.enabled': return context.config.stickers.enabled;
    case 'behavior.stickers.maxRatio': return context.config.stickers.maxRatio;
    default: throw new Error('这项设置不在可修改范围内。');
  }
}

function rawCurrentValue(key: string, context: SelfEditContext): unknown {
  const definition = selfEditKey(key);
  if (!definition) throw new Error('这项设置不在可修改范围内。');
  if (definition.target === 'session') return context.muteState.getUntil(context.session) ?? null;
  if (definition.target === 'persona') {
    const id = selectedPersonaId(context.config, context.session.account);
    const { source } = readPersonaSource(context.root, id);
    return personaFieldValue(source, key);
  }
  return readSelfEditValue(key, context);
}

function sameValue(first: unknown, second: unknown): boolean {
  return JSON.stringify(first ?? null) === JSON.stringify(second ?? null);
}

function validateSetValue(definition: SelfEditKeyDefinition, value: unknown, before: unknown): unknown {
  switch (definition.kind) {
    case 'text': return personaTextSchema.parse(value);
    case 'list': return listSchema.parse(value);
    case 'trait': {
      const next = traitSchema.parse(value);
      if (typeof before !== 'number' || Math.abs(next - before) > 1 + 1e-8) {
        throw new Error('性格每次最多调整 1 档。');
      }
      return next;
    }
    case 'time': return timeSchema.parse(value);
    case 'integer': return z.number().int().min(0).max(3_600).parse(value);
    case 'ratio': return z.number().finite().min(0).max(1).parse(value);
    case 'boolean': return z.boolean().parse(value);
    case 'mute': {
      const minutes = z.number().int().min(1).max(1_440).parse(value);
      const until = before;
      if (!Number.isSafeInteger(until === null ? 0 : contextTime(until))
        || !Number.isSafeInteger(contextTime(value))) throw new Error('闭嘴时长超出可处理范围。');
      return minutes;
    }
  }
}

function contextTime(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function setListValue(before: unknown, operation: 'add' | 'remove', value: unknown): string[] {
  const current = listSchema.parse(before);
  const item = listItemSchema.parse(value);
  if (operation === 'add') {
    if (current.includes(item)) throw new Error('这项内容已经存在，无需重复添加。');
    return [...current, item];
  }
  if (!current.includes(item)) throw new Error('没有找到要移除的原内容。');
  return current.filter((entry) => entry !== item);
}

export function prepareSelfEditChanges(
  changes: readonly SelfEditChangeInput[],
  context: SelfEditContext,
): PreparedSelfEditChange[] {
  const seen = new Set<string>();
  const prepared: PreparedSelfEditChange[] = [];
  let target: SelfEditKeyDefinition['target'] | undefined;
  for (const change of changes) {
    if (seen.has(change.key)) throw new Error('同一项设置不能在一次修改中重复出现。');
    seen.add(change.key);
    const definition = selfEditKey(change.key);
    if (!definition || !context.config.selfEdit.scopes.includes(definition.scope)) {
      throw new Error('这项设置不在当前开放的修改白名单内。');
    }
    if (target !== undefined && target !== definition.target) {
      throw new Error('一次只修改同一类设置，请拆成不同的 /aq set 指令。');
    }
    target = definition.target;
    const before = rawCurrentValue(change.key, context);
    let after: unknown;
    let operation: PreparedSelfEditChange['operation'] = change.op;
    if (change.op === 'set') {
      after = validateSetValue(definition, change.value, before);
      if (definition.kind === 'mute') {
        const minutes = after as number;
        after = context.now + minutes * 60_000;
        if (!Number.isSafeInteger(after)) throw new Error('闭嘴时长超出可处理范围。');
      }
    } else {
      if (definition.kind !== 'list' || definition.target !== 'persona') {
        throw new Error('只有人设列表项支持逐条添加或移除。');
      }
      after = setListValue(before, change.op, change.value);
    }
    if (sameValue(before, after)) throw new Error('这项设置已经是目标值，无需修改。');
    prepared.push({
      key: change.key,
      label: definition.label,
      target: definition.target,
      operation,
      before: before ?? null,
      after: after ?? null,
    });
  }
  return prepared;
}

export function prepareSelfEditRollback(
  changes: readonly { key: string; before: unknown; after: unknown }[],
  context: SelfEditContext,
): PreparedSelfEditChange[] {
  if (changes.length < 1 || changes.length > 8) throw new Error('上次修改没有可撤回的内容。');
  const seen = new Set<string>();
  const prepared: PreparedSelfEditChange[] = [];
  let target: SelfEditKeyDefinition['target'] | undefined;
  for (const change of changes) {
    const definition = selfEditKey(change.key);
    if (!definition || !context.config.selfEdit.scopes.includes(definition.scope)) {
      throw new Error('当前设置不再开放修改，无法撤回。');
    }
    if (seen.has(change.key) || (target !== undefined && target !== definition.target)) {
      throw new Error('上次修改记录无法安全撤回。');
    }
    seen.add(change.key);
    target = definition.target;
    const current = rawCurrentValue(change.key, context);
    if (!sameValue(current, change.after)) throw new Error('设置已被其他操作改动，不能直接撤回。');
    prepared.push({
      key: change.key,
      label: definition.label,
      target: definition.target,
      operation: 'restore',
      before: current ?? null,
      after: change.before ?? null,
    });
  }
  return prepared;
}

export function formatSelfEditDiff(changes: readonly PreparedSelfEditChange[], now = Date.now()): string {
  return changes.map((change) => {
    if (change.operation === 'add' || change.operation === 'remove') {
      const value = change.operation === 'add' ? change.after : change.before;
      return `${change.label} ${change.operation === 'add' ? '+' : '−'}「${String(value)}」`;
    }
    if (change.key === 'session.muteMinutes') {
      const minutes = typeof change.after === 'number'
        ? Math.max(0, Math.ceil((change.after - now) / 60_000))
        : 0;
      return `${change.label} ${minutes > 0 ? `设为 ${minutes} 分钟` : '解除'}`;
    }
    const before = typeof change.before === 'number' ? String(change.before) : String(change.before ?? '空');
    const after = typeof change.after === 'number' ? String(change.after) : String(change.after ?? '空');
    return `${change.label}「${before}」→「${after}」`;
  }).join('；');
}

export function applyPersonaChanges(source: string, changes: readonly PreparedSelfEditChange[]): string {
  const form = parseSections(source);
  for (const change of changes) {
    if (change.key.startsWith('persona.traits.')) {
      const key = change.key.slice('persona.traits.'.length) as keyof PersonaTraits;
      form.traits = { ...form.traits, [key]: change.after as number };
      continue;
    }
    const heading = change.key.slice('persona.'.length) as PersonaSectionHeading;
    if (Array.isArray(form.fields[heading])) {
      (form.fields[heading] as string[]) = [...(change.after as string[])];
    } else {
      (form.fields[heading] as string) = String(change.after ?? '');
    }
  }
  return buildSections(form);
}

export function applyConfigChanges(
  config: AquariumConfig,
  changes: readonly PreparedSelfEditChange[],
): AquariumConfig {
  const next = structuredClone(config) as AquariumConfig;
  for (const change of changes) {
    switch (change.key) {
      case 'behavior.sleep.bedtime': next.sleep.bedtime = change.after as string; break;
      case 'behavior.sleep.wake': next.sleep.wake = change.after as string; break;
      case 'behavior.proactiveCooldownSec': next.defaults.proactiveCooldownSec = change.after as number; break;
      case 'behavior.stickers.enabled': next.stickers.enabled = change.after as boolean; break;
      case 'behavior.stickers.maxRatio': next.stickers.maxRatio = change.after as number; break;
      default: throw new Error('这项设置不能写入配置。');
    }
  }
  return AquariumConfigSchema.parse(next);
}

export function assertSelfEditChangesCurrent(
  changes: readonly PreparedSelfEditChange[],
  context: SelfEditContext,
): void {
  for (const change of changes) {
    const definition = selfEditKey(change.key);
    if (!definition || definition.target !== change.target
      || !context.config.selfEdit.scopes.includes(definition.scope)) {
      throw new Error('设置修改范围已变化，请重新提出修改。');
    }
    const current = rawCurrentValue(change.key, context);
    if (!sameValue(current, change.before)) throw new Error('设置在确认前已变化，请重新提出修改。');
  }
}

export function selfEditTarget(changes: readonly PreparedSelfEditChange[]): PreparedSelfEditChange['target'] {
  const first = changes[0];
  if (!first || changes.some((change) => change.target !== first.target)) {
    throw new Error('一次只修改同一类设置。');
  }
  return first.target;
}

export function serializeSelfEditChanges(changes: readonly PreparedSelfEditChange[]) {
  return changes.map(({ key, before, after }) => ({ key, before, after }));
}

export function configurationChangeContext(
  config: AquariumConfig,
  session: SessionKey,
  root: string,
  muteState: SelfEditMuteState,
  now: number,
): SelfEditContext {
  return { config, session, root, muteState, now };
}
