import { resolveSession } from '../../config/resolve.ts';
import { budgetState } from '../../llm/budget.ts';
import { runJudge } from '../activity/judge.ts';
import { calculatePrefilterActivity, calculatePrefilterFeatures, evaluatePrefilter } from '../activity/prefilter.ts';
import { messageTrigger } from '../activity/trigger.ts';
import { createIdleBackoff } from '../activity/backoff.ts';
import { adjustThresholdForTalk, createActivityThreshold } from '../activity/threshold.ts';
import { messageTextWithImageCaptions } from '../images.ts';
import { resolveMode } from '../activity/mode.ts';
import { loadPersona } from '../../persona/load.ts';
import { effectiveTalkLevel } from '../../persona/traits.ts';
import { sleepEnergy, sleepPlan } from '../sleep.ts';
import { createSlotCallOptions } from './call-options.ts';
import { errorDetails } from './errors.ts';
import { traceStep, type PipelineStep } from './types.ts';

const defaultIdleBackoff = createIdleBackoff();
const defaultActivityThreshold = createActivityThreshold();

export const gateStep: PipelineStep = async (ctx) => traceStep(ctx, 'gate', async () => {
  const config = ctx.options.getConfig();
  const resolvedSettings = resolveSession(config, ctx.message.session);
  const settings = {
    ...resolvedSettings,
    mode: resolveMode(resolvedSettings, ctx.now()),
  };
  ctx.state.config = config;
  ctx.state.settings = settings;
  let callOptions = ctx.state.callOptions ?? createSlotCallOptions(ctx, config);
  ctx.state.callOptions = callOptions;

  async function checkGroupPrivacy(triggered: boolean) {
    if (ctx.message.session.kind !== 'group' || !ctx.options.privacyGateService) return undefined;
    const records = ctx.processOptions.replay
      ? ctx.options.repository.recentMessagesThrough(ctx.currentSessionId, ctx.message.messageId, 8)
      : ctx.options.repository.recentMessages(ctx.currentSessionId, 8);
    const messages = records.map((record) => ({
      ...record,
      plainText: messageTextWithImageCaptions(
        record,
        ctx.options.repository,
        ctx.state.promptTemplates.vision.version,
        config.slots.vision?.[0]?.model ?? 'unknown',
      ),
    }));
    const result = await ctx.options.privacyGateService.evaluateGroup({
      session: ctx.message.session,
      senderId: ctx.message.senderId,
      triggered,
      now: ctx.now(),
      messages,
      template: ctx.state.promptTemplates.privacyGate,
      knownFactsTemplate: ctx.state.promptTemplates.replySystem.knownFacts,
    });
    ctx.state.privacyDecisionDetail = result.detail;
    if (result.knownFacts !== undefined || result.privateRule !== undefined) {
      ctx.state.privacyPromptBlocks = {
        ...(result.knownFacts === undefined ? {} : { knownFacts: result.knownFacts }),
        ...(result.privateRule === undefined ? {} : { privateRule: result.privateRule }),
      };
    }
    if (result.suppressDebugTrace) {
      ctx.state.suppressSensitiveDebugTrace = true;
      const safeOptions = { ...callOptions };
      delete safeOptions.debugTrace;
      callOptions = safeOptions;
      ctx.state.callOptions = safeOptions;
    }
    return result;
  }

  if (ctx.processOptions.batched) {
    const privacyAvoid = ctx.options.privacyGateService?.activeAvoid({
      session: ctx.message.session,
      now: ctx.now(),
    });
    if (privacyAvoid) {
      ctx.state.privacyDecisionDetail = privacyAvoid.detail;
      return { next: false, reason: 'privacy_avoid', detail: { privacy: privacyAvoid.detail } };
    }
    return { next: false, reason: 'batched', detail: { trigger: 'proactive' } };
  }

  if (ctx.options.isMuted?.(ctx.message.session)) return { next: false, reason: 'muted' };
  if (!settings.enabled) return { next: false, reason: 'disabled', detail: { enabled: false } };

  const trigger = messageTrigger(ctx.message, settings.nicknames);
  if (trigger === 'none' && settings.mode !== 'mention_only') {
    const proactivePrivacyAvoid = ctx.options.privacyGateService?.activeAvoid({
      session: ctx.message.session,
      now: ctx.now(),
    });
    if (proactivePrivacyAvoid) {
      ctx.state.privacyDecisionDetail = proactivePrivacyAvoid.detail;
      return {
        next: false,
        reason: 'privacy_avoid',
        detail: { privacy: proactivePrivacyAvoid.detail },
      };
    }
  }
  const sleepNow = ctx.now();
  const plan = sleepPlan(sleepNow, config.sleep.bedtime, config.sleep.wake);
  const wakeState = ctx.options.sleepWakeState;
  const temporarilyAwake = plan.asleep && (wakeState?.isAwake(sleepNow) ?? false);
  if (config.sleep.enabled && !ctx.processOptions.replay) {
    const ownerMessage = config.owner !== 0 && ctx.message.senderId === config.owner;
    if (temporarilyAwake) {
      if (ownerMessage) wakeState?.activate(sleepNow);
    } else if (plan.asleep) {
      const hasWakeWord = config.sleep.wakeWords.some((word) => ctx.message.plainText.includes(word));
      if (ownerMessage && trigger !== 'none' && hasWakeWord && wakeState) wakeState.activate(sleepNow);
      else return { next: false, reason: 'asleep', detail: { asleep: true } };
    }
  }
  ctx.state.energy = config.sleep.enabled
    ? sleepEnergy(
      sleepNow,
      plan.wakeAt,
      plan.bedAt,
      ctx.options.repository.replyCountLastHourForAccount(ctx.message.session.account, sleepNow),
      true,
    )
    : 1;
  if (trigger !== 'none') {
    const rate = ctx.processOptions.replay
      ? ctx.rateLimiter.preview(ctx.message.session, ctx.message.senderId, settings.rate)
      : ctx.rateLimiter.check(ctx.message.session, ctx.message.senderId, settings.rate);
    if (!rate.allowed) return { next: false, reason: 'rate_limited', detail: { limit: rate.reason } };
    const privacy = await checkGroupPrivacy(true);
    if (privacy?.action === 'avoid') {
      return { next: false, reason: 'privacy_avoid', detail: { privacy: privacy.detail } };
    }
    if (!ctx.processOptions.replay) {
      ctx.options.moodService?.recordCalled({
        account: ctx.message.session.account,
        sessionId: ctx.currentSessionId,
        now: ctx.now(),
      });
      ctx.options.affinityService?.recordCalled({
        account: ctx.message.session.account,
        userId: ctx.message.senderId,
        sessionId: ctx.currentSessionId,
        now: ctx.now(),
      });
    }
    return {
      next: true,
      ...(ctx.state.privacyDecisionDetail
        ? { detail: { privacy: ctx.state.privacyDecisionDetail } }
        : {}),
    };
  }
  if (settings.mode === 'mention_only') {
    return { next: false, reason: 'mode_mention_only', detail: { trigger: 'none' } };
  }

  const detail: Record<string, unknown> = { trigger: 'proactive' };
  if (budgetState(config, ctx.options.repository.costToday()) === 'exceeded') {
    return { next: false, reason: 'budget', detail: { ...detail, budget: 'exceeded' } };
  }

  const batchMessages = ctx.processOptions.activityBatch?.messages ?? [ctx.message];
  const batchSize = batchMessages.length;
  const backoff = ctx.options.idleBackoff ?? defaultIdleBackoff;
  const backoffStatus = batchSize >= 6 ? 'bypassed' : 'clear';
  if (backoff.shouldBackoff(ctx.currentSessionId, ctx.now(), batchSize)) {
    return {
      next: false,
      reason: 'backoff',
      detail: { ...detail, batchSize, backoff: 'waiting' },
    };
  }

  const firstMessageAt = batchMessages[0]?.time ?? ctx.now();
  const lastBotMessage = ctx.options.repository.lastSelfMessage(ctx.currentSessionId);
  const lastMessageBeforeBatch = Number.isFinite(firstMessageAt)
    ? ctx.options.repository.lastMessageBefore(ctx.currentSessionId, firstMessageAt)
    : undefined;
  const activity = calculatePrefilterActivity({
    now: ctx.now(),
    firstMessageAt,
    ...(lastBotMessage ? { lastBotMessageAt: lastBotMessage.time } : {}),
    ...(lastMessageBeforeBatch ? { lastMessageBeforeBatchAt: lastMessageBeforeBatch.time } : {}),
  });
  const features = calculatePrefilterFeatures(batchMessages, activity);
  const prefilter = evaluatePrefilter(features);
  const prefilterDetail = { ...detail, batchSize, p0: prefilter.p0, backoff: backoffStatus };
  if (!prefilter.shouldJudge) {
    return { next: false, reason: 'prefilter', detail: prefilterDetail };
  }

  const privacy = await checkGroupPrivacy(false);
  if (privacy?.action === 'avoid') {
    return { next: false, reason: 'privacy_avoid', detail: { ...prefilterDetail, privacy: privacy.detail } };
  }
  const privacyDetail = ctx.state.privacyDecisionDetail;
  const prefilterDecisionDetail = privacyDetail
    ? { ...prefilterDetail, privacy: privacyDetail }
    : prefilterDetail;

  const judgeContext = ctx.options.repository.recentMessages(ctx.currentSessionId, 8).map((record) => ({
    time: record.time,
    senderName: record.senderName,
    isSelf: record.isSelf,
    plainText: messageTextWithImageCaptions(
      record,
      ctx.options.repository,
      ctx.state.promptTemplates.vision.version,
      config.slots.vision?.[0]?.model ?? 'unknown',
    ),
  }));
  const judge = await runJudge(
    judgeContext,
    ctx.state.promptTemplates.judge,
    async (slot, messages) => {
      try {
        return await ctx.modelCall(slot, messages, callOptions);
      } catch (error) {
        ctx.options.onError?.(error, ctx.message);
        throw error;
      }
    },
  );
  if (!judge.ok) {
    if (!ctx.processOptions.replay) backoff.recordNoReply(ctx.currentSessionId, ctx.now());
    return { next: false, reason: judge.reason, detail: prefilterDecisionDetail };
  }

  if (ctx.state.personaTraits === undefined) {
    const account = config.accounts.find((entry) => entry.uin === ctx.message.session.account);
    const nickname = ctx.options.getNickname().trim() || String(ctx.message.session.account);
    try {
      const loaded = loadPersona(account?.persona ?? 'default', nickname, {
        ...(ctx.options.personaRoot === undefined ? {} : { root: ctx.options.personaRoot }),
      });
      ctx.state.persona = loaded.text;
      ctx.state.personaTraits = loaded.traits;
    } catch (error) {
      ctx.options.onError?.(error, ctx.message);
      return { next: false, reason: 'persona_error', detail: errorDetails(error) };
    }
  }

  const thresholds = ctx.options.activityThreshold ?? defaultActivityThreshold;
  const baseThreshold = thresholds.getThreshold(ctx.currentSessionId, settings.mode, ctx.now());
  const effectiveTalk = effectiveTalkLevel(ctx.state.personaTraits?.talk ?? 0, settings.talkOffset);
  const energy = ctx.state.energy ?? 1;
  const threshold = adjustThresholdForTalk(baseThreshold, effectiveTalk, energy);
  if (!ctx.processOptions.replay) {
    thresholds.recordJudgment(ctx.currentSessionId, settings.mode, judge.probability, ctx.now());
  }
  const decisionDetail = {
    ...prefilterDecisionDetail,
    probability: judge.probability,
    threshold,
    ...(config.sleep.enabled ? { energy } : {}),
  };
  if (judge.probability < threshold) {
    if (!ctx.processOptions.replay) backoff.recordNoReply(ctx.currentSessionId, ctx.now());
    return { next: false, reason: 'judge_skip', detail: decisionDetail };
  }

  if (thresholds.isProactiveCooldown(ctx.currentSessionId, ctx.now(), settings.proactiveCooldownSec * 1000)) {
    return { next: false, reason: 'proactive_cooldown', detail: decisionDetail };
  }

  const rate = ctx.processOptions.replay
    ? ctx.rateLimiter.preview(ctx.message.session, ctx.message.senderId, settings.rate)
    : ctx.rateLimiter.check(ctx.message.session, ctx.message.senderId, settings.rate);
  if (!rate.allowed) {
    return { next: false, reason: 'rate_limited', detail: { ...decisionDetail, limit: rate.reason } };
  }

  ctx.state.activityDecisionDetail = decisionDetail;
  ctx.state.proactiveMode = settings.mode;
  return { next: true, detail: decisionDetail };
});
