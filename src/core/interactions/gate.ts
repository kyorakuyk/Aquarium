import type { QqGroupRole } from '../../adapters/types.ts';
import type { AquariumConfig } from '../../config/schema.ts';
import { resolveInteractions } from '../../config/resolve.ts';
import { sessionId, type SessionKey } from '../shared/events.ts';
import type {
  InteractionAction,
  InteractionCheckContext,
  InteractionDecision,
  InteractionSource,
  InteractionVerdict,
} from './model.ts';
import type { InteractionLogRepository } from '../../store/interaction-log-repo.ts';

const GLOBAL_ACTION_LIMIT = 4;
const GLOBAL_ACTION_WINDOW_MS = 60_000;
const FAILURE_COOLDOWN_MS = 30 * 60_000;
const MAX_MUTE_SECONDS = 600;
const OTHER_RECALL_WINDOW_MS = 60 * 60_000;
const OTHER_RECALL_LIMIT = 5;

export interface InteractionGateOptions {
  getConfig: () => AquariumConfig;
  log: InteractionLogRepository;
  isMuted: (session: SessionKey) => boolean;
  isOnline: (account: number) => boolean;
  isAsleep: (session: SessionKey, at: number) => boolean;
  isOtherKin: (account: number, targetId: number) => boolean;
  isMarkedBot: (account: number, targetId: number) => boolean;
  getMessageSenderId: (session: SessionKey, messageId: string) => number | undefined;
  getMessageTime: (session: SessionKey, messageId: string) => number | undefined;
  getSelfRole: (session: SessionKey) => QqGroupRole | undefined;
  getTargetRole: (session: SessionKey, targetId: number) => QqGroupRole | undefined;
  execute?: (action: InteractionAction) => Promise<void>;
  now?: () => number;
}

function isManagementAction(action: InteractionAction): boolean {
  return action.kind === 'mute'
    || action.kind === 'essence'
    || (action.kind === 'recall' && !action.ownMessage);
}

function isFeatureEnabled(config: AquariumConfig, action: InteractionAction, source: InteractionSource): boolean {
  const settings = resolveInteractions(config, action.session);
  if (action.kind === 'mute' || action.kind === 'essence') return settings.admin.enabled;
  if (action.kind === 'recall') {
    if (!settings.recall.enabled) return false;
    if (action.ownMessage) return source !== 'llm' && (source !== 'rule' || settings.recall.self_auto);
    return settings.recall.others && settings.admin.enabled;
  }
  return settings[action.kind].enabled;
}

function linkedMessageId(action: InteractionAction, context: InteractionCheckContext): string | undefined {
  if (action.kind === 'react' || action.kind === 'recall' || action.kind === 'essence') return action.messageId;
  return context.sourceMessageId;
}

function actionDetails(action: InteractionAction): Record<string, string | number | boolean> {
  switch (action.kind) {
    case 'react': return { emojiId: action.emojiId, remove: action.remove === true };
    case 'poke': return { targetId: action.targetId };
    case 'recall': return { ownMessage: action.ownMessage };
    case 'mute': return { targetId: action.targetId, seconds: action.seconds };
    case 'essence': return { remove: action.remove === true };
  }
}

function rawTargetId(action: InteractionAction): number | undefined {
  if (action.kind === 'poke' || action.kind === 'mute') return action.targetId;
  return undefined;
}

function messageIdForAction(action: InteractionAction): string | undefined {
  if (action.kind === 'react' || action.kind === 'recall' || action.kind === 'essence') return action.messageId;
  return undefined;
}

export function createInteractionGate(options: InteractionGateOptions) {
  const now = options.now ?? Date.now;
  const accountTails = new Map<number, Promise<void>>();

  function record(
    action: InteractionAction,
    source: InteractionSource,
    verdict: InteractionVerdict,
    reason: string,
    at: number,
    context: InteractionCheckContext,
    targetUserId?: number,
  ): InteractionDecision {
    const target = targetUserId === undefined
      ? rawTargetId(action) === undefined ? messageIdForAction(action) : String(rawTargetId(action))
      : String(targetUserId);
    options.log.recordInteractionLog({
      account: action.session.account,
      time: at,
      sessionId: sessionId(action.session),
      ...(linkedMessageId(action, context) === undefined ? {} : { messageId: linkedMessageId(action, context) }),
      actionKind: action.kind,
      ...(target === undefined ? {} : { target }),
      details: actionDetails(action),
      source,
      verdict,
      reason,
    });
    return { action, source, verdict, reason, at };
  }

  function blocked(
    action: InteractionAction,
    source: InteractionSource,
    reason: string,
    at: number,
    context: InteractionCheckContext,
    targetUserId?: number,
  ): InteractionDecision {
    return record(action, source, 'blocked', reason, at, context, targetUserId);
  }

  function targetUserId(action: InteractionAction): number | undefined {
    const direct = rawTargetId(action);
    if (direct !== undefined) return direct;
    if (action.kind === 'recall' && action.ownMessage) return action.session.account;
    const messageId = messageIdForAction(action);
    return messageId === undefined ? undefined : options.getMessageSenderId(action.session, messageId);
  }

  async function checkUnqueued(
    action: InteractionAction,
    source: InteractionSource = 'rule',
    context: InteractionCheckContext = {},
  ): Promise<InteractionDecision> {
    const at = now();
    const config = options.getConfig();
    const settings = resolveInteractions(config, action.session);

    if (!isFeatureEnabled(config, action, source)) return blocked(action, source, 'disabled', at, context);
    if (options.isMuted(action.session)) return blocked(action, source, 'muted', at, context);
    if (options.isAsleep(action.session, at) && !(action.kind === 'recall' && action.ownMessage)) {
      return blocked(action, source, 'asleep', at, context);
    }
    if (!options.isOnline(action.session.account)) return blocked(action, source, 'offline', at, context);
    if (action.session.kind !== 'group' && (action.kind === 'react' || action.kind === 'mute' || action.kind === 'essence')) {
      return blocked(action, source, 'group_only', at, context);
    }

    if (isManagementAction(action) && source !== 'owner_command') {
      return blocked(action, source, 'owner_command_required', at, context);
    }
    if (source === 'owner_command' && (context.requesterId === undefined || !settings.master_ids.includes(context.requesterId))) {
      return blocked(action, source, 'not_master', at, context);
    }
    if (isManagementAction(action)) {
      if (action.session.kind !== 'group') return blocked(action, source, 'group_only', at, context);
      const selfRole = options.getSelfRole(action.session);
      if (selfRole !== 'admin' && selfRole !== 'owner') return blocked(action, source, 'not_admin', at, context);
    }
    const targetId = targetUserId(action);

    if (action.kind === 'mute') {
      const maxSeconds = Math.min(settings.admin.mute_max_s, MAX_MUTE_SECONDS);
      if (!Number.isSafeInteger(action.seconds) || action.seconds < 0 || action.seconds > maxSeconds) {
        return blocked(action, source, 'mute_too_long', at, context, targetId);
      }
    }

    if (action.kind === 'recall' && !action.ownMessage) {
      const messageTime = options.getMessageTime(action.session, action.messageId);
      if (messageTime === undefined || at - messageTime > 24 * 60 * 60_000 || messageTime > at) {
        return blocked(action, source, 'message_unavailable_or_old', at, context, targetId);
      }
      if (options.log.countAllowedForSession(
        sessionId(action.session), 'recall', at - OTHER_RECALL_WINDOW_MS, at,
      ) >= OTHER_RECALL_LIMIT) {
        return blocked(action, source, 'rate_limit:recall:group_hour', at, context, targetId);
      }
    }

    if (targetId === undefined && !(action.kind === 'recall' && action.ownMessage)) {
      return blocked(action, source, 'target_unknown', at, context);
    }
    if (targetId !== undefined && !(action.kind === 'recall' && action.ownMessage)) {
      if (targetId === action.session.account) return blocked(action, source, 'self_target', at, context, targetId);
      if (isManagementAction(action) && targetId === config.owner) return blocked(action, source, 'target_is_owner', at, context, targetId);
      if (options.isOtherKin(action.session.account, targetId)) return blocked(action, source, 'target_is_kin', at, context, targetId);
      if (options.isMarkedBot(action.session.account, targetId)) return blocked(action, source, 'target_is_bot', at, context, targetId);
      if (isManagementAction(action)) {
        const role = options.getTargetRole(action.session, targetId);
        if (role === undefined) return blocked(action, source, 'target_role_unknown', at, context, targetId);
        if (role === 'owner' || role === 'admin') return blocked(action, source, 'target_is_admin', at, context, targetId);
      }
    }

    const outcomes = options.log.recentOutcomesForAction(sessionId(action.session), action.kind, 3);
    if (outcomes.length === 3 && outcomes.every(({ verdict }) => verdict === 'failed')
      && at - outcomes[0]!.time < FAILURE_COOLDOWN_MS) {
      return blocked(action, source, 'failure_cooldown', at, context, targetId);
    }

    if (options.log.countAllowedForAccount(action.session.account, at - GLOBAL_ACTION_WINDOW_MS, at)
      >= GLOBAL_ACTION_LIMIT) {
      return blocked(action, source, `rate_limit:${action.kind}:minute`, at, context, targetId);
    }

    const hourlyLimit = action.kind === 'react'
      ? settings.react.per_hour_max
      : action.kind === 'poke' ? settings.poke.per_hour_max : undefined;
    if (hourlyLimit !== undefined
      && options.log.countAllowedForAccount(action.session.account, at - 60 * 60_000, at, action.kind) >= hourlyLimit) {
      return blocked(action, source, `rate_limit:${action.kind}:hour`, at, context, targetId);
    }

    const senderGap = action.kind === 'react'
      ? settings.react.per_sender_gap_s
      : action.kind === 'poke' ? settings.poke.per_user_gap_s : undefined;
    if (senderGap !== undefined && targetId !== undefined) {
      const previous = options.log.latestAllowedForTarget(action.session.account, action.kind, String(targetId));
      if (previous && at - previous.time < senderGap * 1000) {
        return blocked(action, source, `rate_limit:${action.kind}:sender`, at, context, targetId);
      }
    }

    if (!options.execute || (isManagementAction(action) && settings.admin.dry_run)) {
      const reason = isManagementAction(action) && settings.admin.dry_run ? 'dry_run' : 'executor_unavailable';
      return record(action, source, 'dry_run', reason, at, context, targetId);
    }

    try {
      await options.execute(action);
      return record(action, source, 'executed', 'executed', at, context, targetId);
    } catch {
      return record(action, source, 'failed', 'adapter_error', at, context, targetId);
    }
  }

  function check(
    action: InteractionAction,
    source: InteractionSource = 'rule',
    context: InteractionCheckContext = {},
  ): Promise<InteractionDecision> {
    const account = action.session.account;
    const previous = accountTails.get(account) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    accountTails.set(account, tail);
    return previous.then(() => checkUnqueued(action, source, context)).finally(() => {
      release();
      if (accountTails.get(account) === tail) accountTails.delete(account);
    });
  }

  return { check };
}
