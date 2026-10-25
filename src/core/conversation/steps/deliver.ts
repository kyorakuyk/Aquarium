import type { Segment } from '../../shared/events.ts';
import type { StickerOffer } from '../../stickers/selection.ts';
import { replyDelayMs } from '../pacing.ts';
import { splitReply, type SplitReplyOptions } from '../../shared/split.ts';
import { effectiveTalkLevel, replyPartLimitForTalk } from '../../../persona/traits.ts';
import { errorDetails } from './errors.ts';
import { traceStep, type PipelineStep, type StepContext } from './types.ts';
import { markEventAdvocacyConfirmationPrompt } from '../../privacy/event-advocacy.ts';

function splitOptionsForContext(ctx: StepContext): { maxParts: 1 | 2 | 3; options: SplitReplyOptions } {
  const effectiveTalk = effectiveTalkLevel(
    ctx.state.personaTraits?.talk ?? 0,
    ctx.state.settings?.talkOffset ?? 0,
  );
  const profile = ctx.state.personaProfile;
  return {
    maxParts: replyPartLimitForTalk(effectiveTalk),
    options: {
      segmenting: profile?.speech.segmenting ?? 'multi',
      maxPartLength: profile?.speech.length.max ?? 80,
    },
  };
}

function splitReplyForDelivery(
  ctx: StepContext,
  replyText: string,
  maxParts: 1 | 2 | 3,
  options: SplitReplyOptions,
): { spokenParts: string[]; parts: string[] } {
  const asides = ctx.state.innerVoiceMode === 'full' ? ctx.state.innerVoice ?? [] : [];
  let spokenText = replyText;
  for (const aside of asides) {
    if (!aside) continue;
    const index = spokenText.indexOf(aside);
    if (index >= 0) spokenText = spokenText.slice(0, index) + spokenText.slice(index + aside.length);
  }
  const cleanedSpokenText = spokenText
    .split(/\r\n|\r|\n/u)
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
  const spokenParts = splitReply(cleanedSpokenText, maxParts, options);
  const firstAside = asides.find((aside) => aside.length > 0);
  return { spokenParts, parts: [...spokenParts, ...(firstAside ? [firstAside] : [])] };
}

function stickerFallbackSegments(base64: string): Segment[] {
  return [{ type: 'image', url: `base64://${base64}`, file: `base64://${base64}` }];
}

function saveInnerVoice(ctx: StepContext, messageId: string, time: number): void {
  const innerVoice = ctx.state.innerVoice;
  if (!innerVoice?.length) return;
  try {
    ctx.options.repository.saveInnerVoiceForMessage(ctx.currentSessionId, messageId, innerVoice, time);
  } catch (error) {
    ctx.options.onError?.(error, ctx.message);
  }
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
    if (ctx.state.sentMessageIds.length === 0) saveInnerVoice(ctx, sent.messageId, sentAt);
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
      if (ctx.state.sentMessageIds.length === 0) saveInnerVoice(ctx, sent.messageId, sentAt);
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
  const splitOptions = splitOptionsForContext(ctx);
  ctx.state.parts = splitReplyForDelivery(ctx, replyText, splitOptions.maxParts, splitOptions.options).parts;
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
  const splitOptions = splitOptionsForContext(ctx);
  const { spokenParts, parts } = splitReplyForDelivery(
    ctx,
    replyText,
    splitOptions.maxParts,
    splitOptions.options,
  );
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
    const sentAt = ctx.now();
    ctx.options.repository.saveMessage({
      sessionId: ctx.currentSessionId,
      messageId: sent.messageId,
      senderId: ctx.message.session.account,
      senderName: nickname,
      isSelf: true,
      plainText: text,
      segments,
      time: sentAt,
    });
    if (index === 0) saveInnerVoice(ctx, sent.messageId, sentAt);
    if (index < spokenParts.length && ctx.state.eventAdvocacyPromptEventId !== undefined) {
      try {
        markEventAdvocacyConfirmationPrompt({
          repository: ctx.options.repository,
          session: ctx.message.session,
          eventId: ctx.state.eventAdvocacyPromptEventId,
          messageId: sent.messageId,
          replyText: text,
          now: ctx.now(),
        });
      } catch (error) {
        ctx.options.onError?.(error, ctx.message);
      }
    }
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
