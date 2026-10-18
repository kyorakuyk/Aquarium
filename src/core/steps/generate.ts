import { cleanReply } from '../text.ts';
import type { SlotRequestParams } from '../../llm/slots.ts';
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
    ctx.options.onError?.(error, ctx.message);
    return { next: false, reason: 'llm_error', detail: errorDetails(error) };
  }

  ctx.state.result = result;
  const params = safeRequestParams(result.params);
  const replyText = cleanReply(result.text, [nickname, ...settings.nicknames]);
  ctx.state.replyText = replyText;
  if (!replyText) return { next: false, reason: 'empty_reply', detail: { model: result.model, params } };
  return { next: true, detail: { params } };
});
