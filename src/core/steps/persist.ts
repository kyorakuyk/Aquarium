import { traceStep, type PipelineStep } from './types.ts';
import { messageRecord } from './types.ts';

export const persistStep: PipelineStep = async (ctx) => traceStep(ctx, 'persist', async () => {
  const inserted = ctx.processOptions.replay === true
    || ctx.processOptions.alreadySaved === true
    || ctx.options.repository.saveMessage(messageRecord(ctx.message, ctx.currentSessionId));
  if (!inserted) return { next: false, reason: 'duplicate' };
  if (!ctx.processOptions.replay && ctx.message.session.kind === 'group') {
    ctx.options.impressionsService?.maybeExtract({
      session: ctx.message.session,
      now: ctx.now(),
      template: ctx.state.promptTemplates.extractTags,
    });
  }
  return { next: true };
});
