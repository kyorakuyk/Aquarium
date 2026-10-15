import { isDebugEnabled } from '../../config/debug.ts';
import { buildPromptMessages, hashPromptMessages } from '../prompt.ts';
import { captionIncomingImages, messageTextWithImageCaptions } from '../images.ts';
import { loadPersona } from '../../persona/load.ts';
import { errorDetails } from './errors.ts';
import { traceStep, type PipelineStep } from './types.ts';

export const contextStep: PipelineStep = async (ctx) => traceStep(ctx, 'context', async () => {
  const config = ctx.state.config;
  const settings = ctx.state.settings;
  if (!config || !settings) throw new Error('gate step must run before context step');

  const account = config.accounts.find((entry) => entry.uin === ctx.message.session.account);
  const nickname = ctx.options.getNickname().trim() || String(ctx.message.session.account);
  let persona: string;
  try {
    persona = loadPersona(account?.persona ?? 'default', nickname, {
      ...(ctx.options.personaRoot === undefined ? {} : { root: ctx.options.personaRoot }),
    });
  } catch (error) {
    ctx.options.onError?.(error, ctx.message);
    return { next: false, reason: 'persona_error', detail: errorDetails(error) };
  }

  const debugEnabled = isDebugEnabled(config, ctx.currentSessionId);
  const callOptions = {
    config,
    costToday: () => ctx.options.repository.costToday(),
    recordUsage: (usage: Parameters<typeof ctx.options.repository.recordUsage>[0]) => {
      ctx.options.repository.recordUsage(usage);
      if (ctx.processOptions.replay) {
        ctx.state.replayTotalCostCny = (ctx.state.replayTotalCostCny ?? 0) + usage.costCny;
        if (usage.slot === 'reply') {
          ctx.state.replayReplyCostCny = (ctx.state.replayReplyCostCny ?? 0) + usage.costCny;
        }
      }
    },
    ...(debugEnabled && !ctx.processOptions.replay ? {
      debugTrace: {
        sessionId: ctx.currentSessionId,
        messageId: ctx.message.messageId,
        record: (trace: Parameters<typeof ctx.options.repository.recordDebugTrace>[0]) => ctx.options.repository.recordDebugTrace(trace),
        onPromptHash: (hash: string) => { ctx.state.promptHash = hash; },
        onError: (error: unknown) => ctx.options.onError?.(error, ctx.message),
      },
    } : {}),
  };
  ctx.state.nickname = nickname;
  ctx.state.persona = persona;
  ctx.state.callOptions = callOptions;

  // TODO(M2): 引入私密信息分级后，调试记录必须对 L0 内容脱敏（DESIGN §10.1）
  await captionIncomingImages({
    message: ctx.message,
    repository: ctx.options.repository,
    visionTemplate: ctx.state.promptTemplates.vision,
    callVision: (messages) => ctx.modelCall('vision', messages, callOptions),
    ...(ctx.options.downloadImage === undefined ? {} : { downloadImage: ctx.options.downloadImage }),
    ...(ctx.options.onError === undefined ? {} : { onError: ctx.options.onError }),
    now: ctx.now,
  });

  const context = (ctx.processOptions.replay
    ? ctx.options.repository.recentMessagesThrough(ctx.currentSessionId, ctx.message.messageId, settings.contextMessages)
    : ctx.options.repository.recentMessages(ctx.currentSessionId, settings.contextMessages))
    .map((record) => ({
      ...record,
      plainText: messageTextWithImageCaptions(record, ctx.options.repository),
    }));
  ctx.state.prompt = buildPromptMessages({
    persona,
    ownerId: config.owner,
    groupNote: settings.groupNote,
    context,
    replySystemTemplate: ctx.state.promptTemplates.replySystem,
  });
  ctx.state.promptHash = hashPromptMessages(ctx.state.prompt);
  return { next: true };
});
