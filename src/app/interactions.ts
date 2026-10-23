import type { EmojiLikeNotice, ProtocolAdapter } from '../adapters/types.ts';
import type { AquariumConfig } from '../config/schema.ts';
import type { AffinityService } from '../core/affinity/service.ts';
import type { InteractionAction } from '../core/interactions/model.ts';
import { createInteractionGate } from '../core/interactions/gate.ts';
import { createReactionRuleService, loadEmojiWhitelist, type ReactionRuleService } from '../core/interactions/reaction-rules.ts';
import { sleepPlan, type SleepWakeState } from '../core/sleep/index.ts';
import { sessionId, type IncomingMessage, type SessionKey } from '../core/shared/events.ts';
import type { InteractionLogRepository } from '../store/interaction-log-repo.ts';
import type { StoreRepository } from '../store/repository.ts';

export function createEmojiLikeFeedbackHandler(options: {
  account: number;
  repository: StoreRepository;
  affinityService: AffinityService;
  now: () => number;
  onFeedback?: (notice: EmojiLikeNotice) => void;
}): (notice: EmojiLikeNotice) => boolean {
  return (notice) => {
    if (notice.type !== 'emoji_like' || notice.subType !== 'add'
      || notice.session.kind !== 'group' || notice.session.account !== options.account
      || options.repository.mainUserIdFor(options.account, notice.userId) === options.account
      || options.repository.sameKinGroup(options.account, notice.userId)
      || !notice.likes.some(({ count }) => count > 0)
      || options.repository.getAccountKind(options.account, notice.userId)?.kind === 'bot') {
      return false;
    }
    const currentSessionId = sessionId(notice.session);
    const message = options.repository.messageBySessionAndId(currentSessionId, notice.messageId);
    if (!message?.isSelf) return false;

    options.affinityService.recordAppraise({
      account: options.account,
      userId: notice.userId,
      sessionId: currentSessionId,
      appliedDv: 0.05,
      time: options.now(),
      reason: 'emoji_like_received',
    });
    options.onFeedback?.(notice);
    return true;
  };
}

export interface AccountInteractionRuntimeOptions {
  account: number;
  adapter: ProtocolAdapter;
  getConfig: () => AquariumConfig;
  repository: StoreRepository;
  interactionLogRepository: InteractionLogRepository;
  sleepWakeState: SleepWakeState;
  isMuted: (session: SessionKey) => boolean;
  isOnline: () => boolean;
  now: () => number;
  onError?: (error: unknown, message: IncomingMessage) => void;
}

export interface AccountInteractionRuntime {
  gate: ReturnType<typeof createInteractionGate>;
  reactionService: ReactionRuleService;
}

export function createAccountInteractionRuntime(options: AccountInteractionRuntimeOptions): AccountInteractionRuntime {
  if (options.account !== options.adapter.account) throw new Error('Interaction runtime account mismatch');
  const whitelist = loadEmojiWhitelist();
  const allowedEmojiIds = new Set(Object.values(whitelist).flatMap((entries) => entries.map(({ emoji_id }) => emoji_id)));
  const gate = createInteractionGate({
    getConfig: options.getConfig,
    log: options.interactionLogRepository,
    isMuted: options.isMuted,
    isOnline: (account) => account === options.account && options.isOnline(),
    isAsleep: (session, at) => {
      if (session.account !== options.account) return true;
      const config = options.getConfig();
      if (!config.sleep.enabled) return false;
      return sleepPlan(at, config.sleep.bedtime, config.sleep.wake).asleep
        && !options.sleepWakeState.isAwake(at);
    },
    isOtherKin: (account, targetId) => account !== options.account
      || options.repository.sameKinGroup(account, targetId),
    isMarkedBot: (account, targetId) => options.repository.getAccountKind(account, targetId)?.kind === 'bot',
    isAllowedEmojiId: (emojiId) => allowedEmojiIds.has(emojiId),
    getMessageSenderId: (session, messageId) => options.repository
      .messageBySessionAndId(sessionId(session), messageId)?.senderId,
    getMessageTime: (session, messageId) => options.repository
      .messageBySessionAndId(sessionId(session), messageId)?.time,
    getSelfRole: () => undefined,
    getTargetRole: () => undefined,
    execute: async (action: InteractionAction) => {
      if (action.kind !== 'react') throw new Error('Interaction action is not available in P1');
      await options.adapter.react(action.session, action.messageId, action.emojiId, action.remove);
    },
    now: options.now,
  });
  return {
    gate,
    reactionService: createReactionRuleService({ gate, whitelist, onError: options.onError }),
  };
}
