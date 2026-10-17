import { buildPromptMessages, describePromptBlocks, hashPromptMessages } from '../prompt.ts';
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
  const tagBlocks = ctx.options.impressionsService?.promptBlocks({
    session: ctx.message.session,
    sessionId: ctx.currentSessionId,
    senderId: ctx.message.senderId,
    senderName: ctx.message.senderName,
    now: ctx.now(),
    template: ctx.state.promptTemplates.replySystem,
  }) ?? { droppedTags: 0 };
  if (tagBlocks.droppedTags > 0) ctx.state.droppedTags = tagBlocks.droppedTags;
  const moodBlocks = ctx.options.moodService?.promptBlocks({
    account: ctx.message.session.account,
    now: ctx.now(),
    template: ctx.state.promptTemplates.affect,
    record: !ctx.processOptions.replay,
  }) ?? {};
  const affinityBlock = ctx.options.affinityService?.promptBlock({
    account: ctx.message.session.account,
    userId: ctx.message.senderId,
    name: ctx.message.senderName,
    now: ctx.now(),
    template: ctx.state.promptTemplates.affect,
  });
  const promptOptions = {
    persona,
    ownerId: config.owner,
    groupNote: settings.groupNote,
    modeHint: settings.mode === 'busy' ? '你现在有点忙，回得简短随意。' : '',
    request: ctx.state.proactiveMode ? '请自然回应最近的群聊，不要要求别人提到你。' : undefined,
    context,
    blocks: {
      ...moodBlocks,
      ...(tagBlocks.groupTags === undefined ? {} : { groupTags: tagBlocks.groupTags }),
      ...(tagBlocks.memberTags === undefined ? {} : { memberTags: tagBlocks.memberTags }),
      ...(affinityBlock === undefined ? {} : { affinity: affinityBlock }),
    },
    replySystemTemplate: ctx.state.promptTemplates.replySystem,
  };
  ctx.state.prompt = buildPromptMessages(promptOptions);
  ctx.state.promptBlocks = describePromptBlocks(promptOptions);
  ctx.state.promptHash = hashPromptMessages(ctx.state.prompt);
  return { next: true };
});
