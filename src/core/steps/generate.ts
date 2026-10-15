import { cleanReply } from '../text.ts';
import { errorDetails } from './errors.ts';
import { traceStep, type PipelineStep } from './types.ts';

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
  const replyText = cleanReply(result.text, [nickname, ...settings.nicknames]);
  ctx.state.replyText = replyText;
  if (!replyText) return { next: false, reason: 'empty_reply', detail: { model: result.model } };
  return { next: true };
});
