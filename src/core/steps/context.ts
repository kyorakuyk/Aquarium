import { buildPromptMessages, hashPromptMessages } from '../prompt.ts';
import { captionIncomingImages, messageTextWithImageCaptions } from '../images.ts';
import { loadPersona } from '../../persona/load.ts';
import { createSlotCallOptions } from './call-options.ts';
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

  const callOptions = ctx.state.callOptions ?? createSlotCallOptions(ctx, config);
  ctx.state.callOptions = callOptions;
  ctx.state.nickname = nickname;
  ctx.state.persona = persona;

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

  const contextCount = ctx.state.proactiveMode ? 8 : settings.contextMessages;
  const context = (ctx.processOptions.replay
    ? ctx.options.repository.recentMessagesThrough(ctx.currentSessionId, ctx.message.messageId, contextCount)
    : ctx.options.repository.recentMessages(ctx.currentSessionId, contextCount))
    .map((record) => ({
      ...record,
      plainText: messageTextWithImageCaptions(record, ctx.options.repository),
    }));
  ctx.state.prompt = buildPromptMessages({
    persona,
    ownerId: config.owner,
    groupNote: settings.groupNote,
    modeHint: settings.mode === 'busy' ? '你现在有点忙，回得简短随意。' : '',
    request: ctx.state.proactiveMode ? '请自然回应最近的群聊，不要要求别人提到你。' : undefined,
    context,
    replySystemTemplate: ctx.state.promptTemplates.replySystem,
  });
  ctx.state.promptHash = hashPromptMessages(ctx.state.prompt);
  return { next: true };
});
