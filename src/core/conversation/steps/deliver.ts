import type { Segment } from '../../shared/events.ts';
import type { StickerOffer } from '../../stickers/selection.ts';
import { replyDelayMs } from '../pacing.ts';
import { splitReply } from '../../shared/split.ts';
import { effectiveTalkLevel, replyPartLimitForTalk } from '../../../persona/traits.ts';
import { errorDetails } from './errors.ts';
import { traceStep, type PipelineStep, type StepContext } from './types.ts';

function maxPartsForContext(ctx: StepContext): 1 | 2 | 3 {
  const effectiveTalk = effectiveTalkLevel(
    ctx.state.personaTraits?.talk ?? 0,
    ctx.state.settings?.talkOffset ?? 0,
  );
  return replyPartLimitForTalk(effectiveTalk);
}

function stickerFallbackSegments(base64: string): Segment[] {
  return [{ type: 'image', url: `base64://${base64}`, file: `base64://${base64}` }];
}

function recordStickerSend(ctx: StepContext, messageId: string, stickerId: number, time: number): void {
  ctx.state.sentMessageIds.push(messageId);
  ctx.state.stickerSent = { id: stickerId, stickerOnly: ctx.state.stickerOnly === true };
  try {
    ctx.options.stickerService?.recordUse(stickerId, time);
  } catch (error) {
    ctx.options.onError?.(error, ctx.message);
  }
}

async function sendSticker(ctx: StepContext, sticker: StickerOffer['candidates'][number]): Promise<void> {
  const service = ctx.options.stickerService;
  if (!service) return;
  const sentAt = ctx.now();
  try {
    const sent = await service.sendSticker({ session: ctx.message.session, sticker });
    ctx.options.repository.saveMessage({
      sessionId: ctx.currentSessionId,
      messageId: sent.messageId,
      senderId: ctx.message.session.account,
      senderName: ctx.state.nickname ?? String(ctx.message.session.account),
      isSelf: true,
      plainText: '',
      segments: [{ type: 'sticker', emojiId: sticker.emojiId }],
      time: sentAt,
    });
    recordStickerSend(ctx, sent.messageId, sticker.id, sentAt);
    return;
  } catch (primaryError) {
    const base64 = service.stickerBase64(sticker.file);
    if (!base64) {
      ctx.options.onError?.(primaryError, ctx.message);
      return;
    }
    try {
      const segments = stickerFallbackSegments(base64);
      const sent = await ctx.options.adapter.send(ctx.message.session, segments);
      ctx.options.repository.saveMessage({
        sessionId: ctx.currentSessionId,
        messageId: sent.messageId,
        senderId: ctx.message.session.account,
        senderName: ctx.state.nickname ?? String(ctx.message.session.account),
        isSelf: true,
        plainText: '',
        segments,
        time: sentAt,
      });
      recordStickerSend(ctx, sent.messageId, sticker.id, sentAt);
    } catch (fallbackError) {
      ctx.options.onError?.(fallbackError, ctx.message);
    }
  }
}

export const replayDeliverStep: PipelineStep = async (ctx) => traceStep(ctx, 'deliver', async () => {
  const result = ctx.state.result;
  const replyText = ctx.state.replyText;
  if (!result || replyText === undefined) {
    throw new Error('generate step must run before replay delivery');
  }
  ctx.state.parts = splitReply(replyText, maxPartsForContext(ctx));
  return { next: false, reason: 'replay', replied: false };
});

export const deliverStep: PipelineStep = async (ctx) => traceStep(ctx, 'deliver', async () => {
  const result = ctx.state.result;
  const replyText = ctx.state.replyText;
  const nickname = ctx.state.nickname;
  if (!result || replyText === undefined || nickname === undefined) {
    throw new Error('generate step must run before deliver step');
  }
  try {
    const egress = ctx.options.privacyGateService?.checkEgress({ session: ctx.message.session, text: replyText });
    if (egress?.blocked) {
      return {
        next: false,
        reason: 'privacy_egress',
        detail: { privacyEgress: { id: egress.factId, level: 'L0' } },
      };
    }
  } catch {
    return {
      next: false,
      reason: 'privacy_egress',
      detail: { privacyEgress: { level: 'L0', checkFailed: true } },
    };
  }
  const parts = splitReply(replyText, maxPartsForContext(ctx));
  ctx.state.parts = parts;
  const sticker = ctx.state.chosenSticker;

  try {
    await ctx.options.adapter.markRead(ctx.message.session);
  } catch (error) {
    ctx.options.onError?.(error, ctx.message);
  }
  if (ctx.message.session.kind === 'private') {
    try {
      await ctx.options.adapter.setTyping(ctx.message.session);
    } catch (error) {
      ctx.options.onError?.(error, ctx.message);
    }
  }

  for (const [index, text] of parts.entries()) {
    const pacingMultiplier = ctx.state.settings?.mode === 'busy' ? 2.5 : 1;
    await ctx.wait(Math.round(replyDelayMs(text, ctx.random) * pacingMultiplier));
    const segments: Segment[] = ctx.processOptions.quoteReplyTo !== false
      && ctx.message.session.kind === 'group' && index === 0
      ? [{ type: 'reply', messageId: ctx.message.messageId }, { type: 'text', text }]
      : [{ type: 'text', text }];
    let sent: { messageId: string };
    try {
      sent = await ctx.options.adapter.send(ctx.message.session, segments);
    } catch (error) {
      ctx.options.onError?.(error, ctx.message);
      return {
        next: false,
        reason: 'send_error',
        detail: { ...errorDetails(error), sentParts: ctx.state.sentMessageIds.length },
        replied: ctx.state.sentMessageIds.length > 0,
      };
    }

    ctx.state.sentMessageIds.push(sent.messageId);
    ctx.options.repository.saveMessage({
      sessionId: ctx.currentSessionId,
      messageId: sent.messageId,
      senderId: ctx.message.session.account,
      senderName: nickname,
      isSelf: true,
      plainText: text,
      segments,
      time: ctx.now(),
    });
  }

  if (sticker) await sendSticker(ctx, sticker);

  return {
    next: false,
    reason: 'replied',
    detail: {
      model: result.model,
      provider: result.provider,
      sentMessageIds: ctx.state.sentMessageIds,
      parts: parts.length,
      costCny: result.usage.costCny,
    },
    replied: true,
  };
});
