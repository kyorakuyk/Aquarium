import { traceStep, type PipelineStep } from './types.ts';
import { messageRecord } from './types.ts';
import { processEventAdvocacyConfirmationMessage } from '../../privacy/event-advocacy.ts';

export const persistStep: PipelineStep = async (ctx) => traceStep(ctx, 'persist', async () => {
  const inserted = ctx.processOptions.replay === true
    || ctx.processOptions.alreadySaved === true
    || ctx.options.repository.saveMessage(messageRecord(ctx.message, ctx.currentSessionId));
  if (!ctx.processOptions.replay && ctx.message.session.kind === 'private') {
    ctx.options.privateFactsService?.revokeEventNotesIfRequested({
      session: ctx.message.session,
      messageId: ctx.message.messageId,
      senderId: ctx.message.senderId,
      now: ctx.now(),
    });
    const confirmation = processEventAdvocacyConfirmationMessage({
      repository: ctx.options.repository,
      session: ctx.message.session,
      messageId: ctx.message.messageId,
      senderId: ctx.message.senderId,
      now: ctx.now(),
    });
    for (const eventId of confirmation.confirmedEventIds) {
      try {
        ctx.options.onEventAdvocacyConfirmed?.(eventId);
      } catch {
        // 确认已持久化；调度失败由周期任务继续处理。
      }
    }
  }
  if (!inserted) {
    if (!ctx.processOptions.replay) ctx.options.personaMemoryService?.observeMessage(ctx.message);
    return { next: false, reason: 'duplicate' };
  }
  if (!ctx.processOptions.replay && ctx.options.personaMemoryService) {
    ctx.options.personaMemoryService.observeMessage(ctx.message);
  } else if (!ctx.processOptions.replay && ctx.message.session.kind === 'group') {
    ctx.options.privateMentionService?.maybePromote({
      session: ctx.message.session,
      senderId: ctx.message.senderId,
      messageId: ctx.message.messageId,
      now: ctx.now(),
      template: ctx.state.promptTemplates.privacyMention,
    });
    ctx.options.impressionsService?.maybeExtract({
      session: ctx.message.session,
      now: ctx.now(),
      template: ctx.state.promptTemplates.extractTags,
    });
  }
  if (!ctx.options.personaMemoryService && !ctx.processOptions.replay && ctx.message.session.kind === 'private'
    && ctx.message.senderId === ctx.message.session.peer
    && ctx.message.senderId !== ctx.message.session.account) {
    ctx.options.privateFactsService?.maybeExtract({
      session: ctx.message.session,
      messageId: ctx.message.messageId,
      senderId: ctx.message.senderId,
      now: ctx.now(),
      template: ctx.state.promptTemplates.extractPrivate,
    });
  }
  return { next: true };
});
