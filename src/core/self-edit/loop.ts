import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type OpenAI from 'openai';
import type { AquariumConfig } from '../../config/schema.ts';
import { redactSensitiveText } from '../impressions/sensitive-text.ts';
import { sessionId, type IncomingMessage } from '../shared/events.ts';
import { applySelfEditProposal } from './apply.ts';
import {
  isRollbackRequest,
  isSelfEditConfirmation,
  parseSelfEditCommand,
  plainTextOnly,
} from './command.ts';
import { createExpiringStateStore } from './pending.ts';
import { SelfEditActionSchema, selfEditKey, selfEditKeysForScopes } from './registry.ts';
import {
  formatSelfEditDiff,
  prepareSelfEditChanges,
  prepareSelfEditRollback,
  readSelfEditValue,
  selectedPersonaId,
  selfEditTarget,
  type PreparedSelfEditChange,
} from './tools.ts';
import type { SelfEditCommandHandler, SelfEditHandlerDependencies } from './types.ts';

const PENDING_TTL_MS = 10 * 60_000;
const MAX_MODEL_TURNS = 4;
const MAX_REQUEST_CHARS = 2_000;
const MAX_RESPONSE_CHARS = 24_000;

type AskState = {
  kind: 'ask';
  expiresAt: number;
  messages: OpenAI.ChatCompletionMessageParam[];
  askCount: 1;
};

type ConfirmState = {
  kind: 'confirm';
  expiresAt: number;
  changes: PreparedSelfEditChange[];
  account: number;
  ownerId: number;
  personaId?: string;
  rollback?: true;
};

type SelfEditState = AskState | ConfirmState;

function safeText(value: string): string {
  return redactSensitiveText(value.trim().slice(0, MAX_RESPONSE_CHARS));
}

function commandKey(message: IncomingMessage): string {
  return sessionId(message.session);
}

function ownerCanUse(config: AquariumConfig, message: IncomingMessage): boolean {
  return config.owner > 0 && message.senderId === config.owner;
}

function systemPrompt(dependencies: SelfEditHandlerDependencies): string {
  const promptPath = join(dependencies.root, 'prompts', 'self-edit.md');
  if (!existsSync(promptPath)) throw new Error('Self-edit system prompt is missing');
  const prompt = readFileSync(promptPath, 'utf8');
  const scopes = dependencies.getConfig().selfEdit.scopes;
  const keys = selfEditKeysForScopes(scopes).map(({ key, label, kind }) => ({ key, label, kind }));
  return `${prompt}\n\n当前可读写白名单：${JSON.stringify(keys)}。只可选择此列表中的 key。`;
}

function startMessages(
  dependencies: SelfEditHandlerDependencies,
  request: string,
): OpenAI.ChatCompletionMessageParam[] {
  return [
    { role: 'system', content: systemPrompt(dependencies) },
    { role: 'user', content: JSON.stringify({ request, untrustedData: true }) },
  ];
}

function terminalReply(text: string, reason: string, detail?: unknown) {
  return { text: safeText(text), reason, ...(detail === undefined ? {} : { detail }) };
}

function makeConfirmationText(say: string, changes: readonly PreparedSelfEditChange[], now: number): string {
  return `${safeText(say)}\n精确变更：${formatSelfEditDiff(changes, now)}\n回复“好 / 可以 / 确认 / 嗯”可以吗？其他普通消息不会执行修改（10 分钟内有效）。`;
}

export function createSelfEditHandler(
  dependencies: SelfEditHandlerDependencies,
): SelfEditCommandHandler {
  const now = dependencies.now ?? Date.now;
  const states = createExpiringStateStore<SelfEditState>(now);

  function shouldHandle(message: IncomingMessage, ownerId: number): boolean {
    if (ownerId === 0 || message.senderId !== ownerId || !plainTextOnly(message)) return false;
    if (parseSelfEditCommand(message) !== undefined) return true;
    const key = commandKey(message);
    const state = states.get(key);
    if (!state || state.kind === 'ask') return false;
    if (isSelfEditConfirmation(message)) return true;
    states.delete(key);
    return false;
  }

  function context(message: IncomingMessage, config = dependencies.getConfig()) {
    return {
      config,
      root: dependencies.root,
      session: message.session,
      muteState: dependencies.muteState,
      now: now(),
    };
  }

  async function proposeRollback(message: IncomingMessage) {
    const latest = dependencies.repository.latestSelfEditEvent(
      message.session.account,
      commandKey(message),
    );
    if (!latest || latest.ownerId !== message.senderId) {
      return terminalReply('这个会话里还没有可撤回的设置修改。', 'self_edit_rollback_missing');
    }
    if (latest.personaId !== undefined) {
      try {
        if (selectedPersonaId(dependencies.getConfig(), message.session.account) !== latest.personaId) {
          return terminalReply('当前绑定的人设已变化，不能跨人设撤回。', 'self_edit_rollback_conflict');
        }
      } catch {
        return terminalReply('当前绑定的人设无法确认，不能安全撤回。', 'self_edit_rollback_conflict');
      }
    }
    let changes: PreparedSelfEditChange[];
    try {
      changes = prepareSelfEditRollback(latest.changes, context(message));
    } catch {
      return terminalReply('上次修改已变化或不再开放，不能安全撤回。', 'self_edit_rollback_conflict');
    }
    states.set(commandKey(message), {
      kind: 'confirm',
      expiresAt: now() + PENDING_TTL_MS,
      changes,
      account: message.session.account,
      ownerId: message.senderId,
      ...(latest.personaId ? { personaId: latest.personaId } : {}),
      rollback: true,
    });
    return terminalReply(
      `我可以撤回上次修改。\n精确变更：${formatSelfEditDiff(changes, now())}\n回复“好 / 可以 / 确认 / 嗯”可以吗？其他普通消息不会执行修改（10 分钟内有效）。`,
      'self_edit_rollback_proposed',
      { eventId: latest.id, keys: changes.map(({ key }) => key) },
    );
  }

  async function runLoop(
    message: IncomingMessage,
    messages: OpenAI.ChatCompletionMessageParam[],
    askCount: number,
  ) {
    for (let turn = 0; turn < MAX_MODEL_TURNS; turn += 1) {
      let raw: string;
      try {
        raw = await dependencies.callModel(messages);
      } catch {
        states.delete(commandKey(message));
        return terminalReply('我现在没法处理这项设置，稍后再试一次吧。', 'self_edit_model_error');
      }
      messages.push({ role: 'assistant', content: raw });
      let parsed: ReturnType<typeof SelfEditActionSchema.safeParse>;
      try { parsed = SelfEditActionSchema.safeParse(JSON.parse(raw) as unknown); }
      catch { parsed = SelfEditActionSchema.safeParse(null); }
      if (!parsed.success) {
        states.delete(commandKey(message));
        return terminalReply('这次没有得到可执行的设置方案，请换种说法再试。', 'self_edit_invalid_action');
      }
      const action = parsed.data;
      if (action.action === 'refuse') {
        states.delete(commandKey(message));
        return terminalReply(action.say, 'self_edit_refused');
      }
      if (action.action === 'ask') {
        if (askCount >= 1) {
          states.delete(commandKey(message));
          return terminalReply('还不够明确；请重新用 /aq set 指定具体设置项和值。', 'self_edit_ask_limit');
        }
        states.set(commandKey(message), {
          kind: 'ask',
          expiresAt: now() + PENDING_TTL_MS,
          messages,
          askCount: 1,
        });
        return terminalReply(`${action.say}\n请用 /aq set <补充说明> 继续；10 分钟内有效。`, 'self_edit_asked');
      }
      if (action.action === 'read') {
        const definition = selfEditKey(action.key);
        if (!definition || !dependencies.getConfig().selfEdit.scopes.includes(definition.scope)) {
          states.delete(commandKey(message));
          return terminalReply('这项设置不在当前开放的修改白名单内。', 'self_edit_key_denied');
        }
        try {
          const value = readSelfEditValue(action.key, context(message));
          messages.push({ role: 'user', content: JSON.stringify({ readResult: { key: action.key, value } }) });
        } catch {
          states.delete(commandKey(message));
          return terminalReply('这项设置当前无法读取。', 'self_edit_read_error');
        }
        continue;
      }
      let changes: PreparedSelfEditChange[];
      try {
        changes = prepareSelfEditChanges(action.changes, context(message));
      } catch (error) {
        const detail = error instanceof Error ? error.message : '';
        states.delete(commandKey(message));
        return terminalReply(
          detail.includes('白名单') || detail.includes('可修改范围')
            ? '这项设置不在当前开放的修改白名单内。'
            : `这组改动不符合设置规则：${detail}`,
          'self_edit_change_rejected',
        );
      }
      const target = selfEditTarget(changes);
      if (target === 'session' && message.session.kind !== 'group') {
        states.delete(commandKey(message));
        return terminalReply('“本群闭嘴”只能在群聊里设置。', 'self_edit_group_only');
      }
      states.set(commandKey(message), {
        kind: 'confirm',
        expiresAt: now() + PENDING_TTL_MS,
        changes,
        account: message.session.account,
        ownerId: message.senderId,
        ...(target === 'persona'
          ? { personaId: dependencies.getConfig().accounts.find(({ uin }) => uin === message.session.account)?.persona }
          : {}),
      });
      return terminalReply(
        makeConfirmationText(action.say, changes, now()),
        'self_edit_proposed',
        { keys: changes.map(({ key }) => key) },
      );
    }
    states.delete(commandKey(message));
    return terminalReply('这次设置请求步骤过多，已停止；请拆成更小的修改。', 'self_edit_turn_limit');
  }

  async function handle(message: IncomingMessage) {
    const config = dependencies.getConfig();
    if (!ownerCanUse(config, message)) return terminalReply('', 'self_edit_not_owner');
    const key = commandKey(message);
    let state = states.get(key);
    const request = parseSelfEditCommand(message);
    if (!config.selfEdit.enabled) {
      states.delete(key);
      return terminalReply('对话设置修改当前已关闭。', 'self_edit_disabled');
    }
    if (request !== undefined) {
      if (request.length > MAX_REQUEST_CHARS) {
        return terminalReply('请求太长了，请压缩到 2,000 个字符以内。', 'self_edit_request_too_long');
      }
      if (state?.kind === 'confirm') {
        states.delete(key);
        state = undefined;
      }
      if (isRollbackRequest(request)) {
        states.delete(key);
        return proposeRollback(message);
      }
      if (state?.kind === 'ask') {
        const messages: OpenAI.ChatCompletionMessageParam[] = [
          ...state.messages,
          { role: 'user', content: JSON.stringify({ clarification: request, untrustedData: true }) },
        ];
        states.delete(key);
        return runLoop(message, messages, state.askCount);
      }
      return runLoop(message, startMessages(dependencies, request), 0);
    }
    if (!state || !plainTextOnly(message)) return terminalReply('', 'self_edit_not_triggered');
    states.delete(key);
    if (state.kind === 'ask') {
      return terminalReply('请用 /aq set <补充说明> 继续这次设置修改；本条未作为设置指令处理。', 'self_edit_ask_needs_command');
    }
    if (state.account !== message.session.account || state.ownerId !== message.senderId) {
      return terminalReply('确认身份或会话不匹配，这次修改已取消。', 'self_edit_confirmation_mismatch');
    }
    if (!isSelfEditConfirmation(message)) {
      return terminalReply('好的，这次修改已取消，没有写入设置。', 'self_edit_cancelled');
    }
    if (state.personaId !== undefined) {
      try {
        if (selectedPersonaId(config, message.session.account) !== state.personaId) {
          return terminalReply('当前绑定的人设已变化，这次修改已取消。', 'self_edit_confirmation_mismatch');
        }
      } catch {
        return terminalReply('当前绑定的人设无法确认，这次修改已取消。', 'self_edit_confirmation_mismatch');
      }
    }
    try {
      const updated = await applySelfEditProposal(dependencies, message, state.changes);
      return terminalReply(
        state.rollback ? `已撤回上次修改。${formatSelfEditDiff(state.changes, now())}` : updated,
        state.rollback ? 'self_edit_rolled_back' : 'self_edit_applied',
        { keys: state.changes.map(({ key }) => key) },
      );
    } catch {
      return terminalReply('保存时遇到问题，请检查人设版本和事件簿；本次未确认成功。', 'self_edit_apply_failed');
    }
  }

  return { shouldHandle, handle };
}
