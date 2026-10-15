import { resolveSession } from '../../config/resolve.ts';
import { traceStep, type PipelineStep } from './types.ts';

export const gateStep: PipelineStep = async (ctx) => traceStep(ctx, 'gate', async () => {
  const config = ctx.options.getConfig();
  const settings = resolveSession(config, ctx.message.session);
  ctx.state.config = config;
  ctx.state.settings = settings;

  if (ctx.options.isMuted?.(ctx.message.session)) return { next: false, reason: 'muted' };
  if (!settings.enabled) return { next: false, reason: 'disabled', detail: { enabled: false } };

  const calledByNickname = settings.nicknames.some((nickname) => {
    const normalized = nickname.trim();
    return normalized !== '' && ctx.message.plainText.includes(normalized);
  });
  const isCalled = ctx.message.session.kind === 'private' || ctx.message.mentionsSelf || calledByNickname;
  if (!isCalled) return { next: false, reason: 'not_mentioned', detail: { trigger: 'none' } };

  const rate = ctx.processOptions.replay
    ? ctx.rateLimiter.preview(ctx.message.session, ctx.message.senderId, settings.rate)
    : ctx.rateLimiter.check(ctx.message.session, ctx.message.senderId, settings.rate);
  if (!rate.allowed) return { next: false, reason: 'rate_limited', detail: { limit: rate.reason } };
  return { next: true };
});
