import { resolveSession } from '../../config/resolve.ts';
import { budgetState } from '../../llm/budget.ts';
import { runJudge } from '../activity/judge.ts';
import { calculatePrefilterActivity, calculatePrefilterFeatures, evaluatePrefilter } from '../activity/prefilter.ts';
import { messageTrigger } from '../activity/trigger.ts';
import { createIdleBackoff } from '../activity/backoff.ts';
import { createActivityThreshold } from '../activity/threshold.ts';
import { messageTextWithImageCaptions } from '../images.ts';
import { resolveMode } from '../activity/mode.ts';
import { createSlotCallOptions } from './call-options.ts';
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
  const callOptions = ctx.state.callOptions ?? createSlotCallOptions(ctx, config);
  ctx.state.callOptions = callOptions;

  if (ctx.processOptions.batched) {
    return { next: false, reason: 'batched', detail: { trigger: 'proactive' } };
  }

  if (ctx.options.isMuted?.(ctx.message.session)) return { next: false, reason: 'muted' };
  if (!settings.enabled) return { next: false, reason: 'disabled', detail: { enabled: false } };

  const trigger = messageTrigger(ctx.message, settings.nicknames);
  if (trigger !== 'none') {
    const rate = ctx.processOptions.replay
      ? ctx.rateLimiter.preview(ctx.message.session, ctx.message.senderId, settings.rate)
      : ctx.rateLimiter.check(ctx.message.session, ctx.message.senderId, settings.rate);
    if (!rate.allowed) return { next: false, reason: 'rate_limited', detail: { limit: rate.reason } };
    if (!ctx.processOptions.replay) {
      ctx.options.moodService?.recordCalled({
        account: ctx.message.session.account,
        sessionId: ctx.currentSessionId,
        now: ctx.now(),
      });
    }
    return { next: true };
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

  const judgeContext = ctx.options.repository.recentMessages(ctx.currentSessionId, 8).map((record) => ({
    time: record.time,
    senderName: record.senderName,
    isSelf: record.isSelf,
    plainText: messageTextWithImageCaptions(record, ctx.options.repository),
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
    return { next: false, reason: judge.reason, detail: prefilterDetail };
  }

  const thresholds = ctx.options.activityThreshold ?? defaultActivityThreshold;
  const threshold = thresholds.getThreshold(ctx.currentSessionId, settings.mode, ctx.now());
  if (!ctx.processOptions.replay) {
    thresholds.recordJudgment(ctx.currentSessionId, settings.mode, judge.probability, ctx.now());
  }
  const decisionDetail = {
    ...prefilterDetail,
    probability: judge.probability,
    threshold,
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
