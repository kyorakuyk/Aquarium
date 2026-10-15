import { traceStep, type PipelineStep } from './types.ts';
import { messageRecord } from './types.ts';

export const persistStep: PipelineStep = async (ctx) => traceStep(ctx, 'persist', async () => {
  const inserted = ctx.processOptions.replay === true
    || ctx.processOptions.alreadySaved === true
    || ctx.options.repository.saveMessage(messageRecord(ctx.message, ctx.currentSessionId));
  return inserted ? { next: true } : { next: false, reason: 'duplicate' };
});
