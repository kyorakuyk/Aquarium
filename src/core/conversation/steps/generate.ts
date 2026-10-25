import { cleanReply } from '../../shared/text.ts';
import type { SlotRequestParams } from '../../../llm/slots.ts';
import { isBudgetExceededError } from '../../../llm/budget.ts';
import { canSendStickerOnly } from '../../stickers/selection.ts';
import { parseStickerReply } from '../../stickers/parse.ts';
import { extractAsides } from '../../shared/inner-voice.ts';
import { errorDetails } from './errors.ts';
import { traceStep, type PipelineStep } from './types.ts';

function safeRequestParams(params: SlotRequestParams | undefined): SlotRequestParams {
  if (!params || typeof params !== 'object') return {};
  return {
    ...(typeof params.temperature === 'number' && Number.isFinite(params.temperature)
      && params.temperature >= 0 && params.temperature <= 2
      ? { temperature: params.temperature }
      : {}),
    ...(Number.isSafeInteger(params.maxTokens) && (params.maxTokens ?? 0) > 0
      ? { maxTokens: params.maxTokens }
      : {}),
    ...(params.reasoning === 'low' || params.reasoning === 'medium' || params.reasoning === 'high'
      ? { reasoning: params.reasoning }
      : {}),
  };
}

export const generateStep: PipelineStep = async (ctx) => traceStep(ctx, 'generate', async () => {
  const prompt = ctx.state.prompt;
  const callOptions = ctx.state.callOptions;
  const nickname = ctx.state.nickname;
  const settings = ctx.state.settings;
  if (!prompt || !callOptions || nickname === undefined || !settings) {
    throw new Error('context step must run before generate step');
  }

  let result;
  try {
    result = await ctx.modelCall('reply', prompt, callOptions);
  } catch (error) {
    if (isBudgetExceededError(error)) return { next: false, reason: 'budget', detail: { budget: 'exceeded' } };
    ctx.options.onError?.(error, ctx.message);
    return { next: false, reason: 'llm_error', detail: errorDetails(error) };
  }

  ctx.state.result = result;
  const params = safeRequestParams(result.params);
  const offer = ctx.processOptions.replay ? undefined : ctx.state.stickerOffer;
  const parsed = parseStickerReply(cleanReply(result.text, [nickname, ...settings.nicknames]), offer);
  const extracted = extractAsides(parsed.text, ctx.state.innerVoiceMode ?? 'light');
  const replyText = extracted.spoken;
  ctx.state.innerVoice = extracted.asides;
  ctx.state.replyText = extracted.spoken;
  if (parsed.sticker) ctx.state.chosenSticker = parsed.sticker;
  if (!replyText && parsed.sticker) {
    const service = ctx.options.stickerService;
    const allowed = !ctx.processOptions.replay && service !== undefined
      && canSendStickerOnly(
        ctx.options.repository.decisionsInRange(
          ctx.currentSessionId,
          ctx.now() - 2 * 60 * 60 * 1000,
          ctx.now(),
        ),
        ctx.now(),
        ctx.state.config?.stickers.onlyStickerRatio ?? 0,
      );
    if (!allowed) {
      return { next: false, reason: 'sticker_only_capped', detail: { model: result.model, params } };
    }
    ctx.state.stickerOnly = true;
    return { next: true, detail: { params } };
  }
  if (!replyText) return { next: false, reason: 'empty_reply', detail: { model: result.model, params } };
  return { next: true, detail: { params } };
});
