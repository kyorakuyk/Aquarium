import { buildPromptMessages, describePromptBlocks, hashPromptMessages } from '../prompt.ts';
import { captionIncomingImages, messageTextWithImageCaptions } from '../images.ts';
import { loadPersona } from '../../persona/load.ts';
import { effectiveTalkLevel, renderTraitsBlock } from '../../persona/traits.ts';
import { renderFloatBlock } from '../mood/render.ts';
import { redactSensitiveText } from '../impressions/sensitive-text.ts';
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
  if (ctx.state.persona !== undefined && ctx.state.personaTraits !== undefined) {
    persona = ctx.state.persona;
  } else {
    try {
      const loaded = loadPersona(account?.persona ?? 'default', nickname, {
        ...(ctx.options.personaRoot === undefined ? {} : { root: ctx.options.personaRoot }),
      });
      persona = loaded.text;
      ctx.state.personaTraits = loaded.traits;
    } catch (error) {
      ctx.options.onError?.(error, ctx.message);
      return { next: false, reason: 'persona_error', detail: errorDetails(error) };
    }
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
    visionModel: config.slots.vision?.[0]?.model ?? 'unknown',
    callVision: (messages) => ctx.modelCall('vision', messages, callOptions),
    ...(ctx.options.downloadImage === undefined ? {} : { downloadImage: ctx.options.downloadImage }),
    ...(ctx.options.onError === undefined ? {} : { onError: ctx.options.onError }),
    now: ctx.now,
    persistMd5: !ctx.processOptions.replay,
  });

  const contextCount = ctx.state.proactiveMode ? 8 : settings.contextMessages;
  const context = (ctx.processOptions.replay
    ? ctx.options.repository.recentMessagesThrough(ctx.currentSessionId, ctx.message.messageId, contextCount)
    : ctx.options.repository.recentMessages(ctx.currentSessionId, contextCount))
    .map((record) => ({
      ...record,
      plainText: messageTextWithImageCaptions(
        record,
        ctx.options.repository,
        ctx.state.promptTemplates.vision.version,
        config.slots.vision?.[0]?.model ?? 'unknown',
      ),
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
  const privateFactsBlock = ctx.options.privateFactsService?.promptBlock({
    session: ctx.message.session,
    name: ctx.message.senderName,
    now: ctx.now(),
    template: ctx.state.promptTemplates.replySystem,
  });
  const moodBlocks = ctx.options.moodService?.promptBlocks({
    account: ctx.message.session.account,
    now: ctx.now(),
    template: ctx.state.promptTemplates.affect,
    energy: ctx.state.energy ?? 1,
    record: !ctx.processOptions.replay,
  }) ?? {};
  if (!ctx.options.moodService && config.sleep.enabled && (ctx.state.energy ?? 1) < 0.35) {
    moodBlocks.float = renderFloatBlock(ctx.state.promptTemplates.affect, 0.5, ctx.state.energy);
  }
  const affinityBlock = ctx.options.affinityService?.promptBlock({
    account: ctx.message.session.account,
    userId: ctx.message.senderId,
    name: ctx.message.senderName,
    now: ctx.now(),
    template: ctx.state.promptTemplates.affect,
  });
  const effectiveTalk = effectiveTalkLevel(ctx.state.personaTraits?.talk ?? 0, settings.talkOffset);
  const traitsBlock = ctx.state.personaTraits
    ? renderTraitsBlock(ctx.state.personaTraits, effectiveTalk, ctx.state.promptTemplates.traits)
    : '';
  const stickersBlock = (() => {
    if (ctx.processOptions.replay || !ctx.options.stickerService) return '';
    const offer = ctx.options.stickerService.offer({
      sessionId: ctx.currentSessionId,
      messageText: ctx.message.plainText,
      moodBand: ctx.options.moodService?.currentBand({
        account: ctx.message.session.account,
        now: ctx.now(),
      }) ?? 'calm',
      now: ctx.now(),
    });
    if (!offer) return '';
    ctx.state.stickerOffer = offer;
    ctx.state.stickerOffered = offer.candidates.map((candidate) => candidate.id);
    return ctx.state.promptTemplates.replySystem.stickers.replaceAll('{{list}}', offer.promptList);
  })();
  const promptOptions = {
    persona,
    ownerId: config.owner,
    groupNote: settings.groupNote,
    modeHint: settings.mode === 'busy' ? '你现在有点忙，回得简短随意。' : '',
    request: ctx.state.proactiveMode ? '请自然回应最近的群聊，不要要求别人提到你。' : undefined,
    context,
    blocks: {
      traits: traitsBlock,
      ...moodBlocks,
      ...(tagBlocks.groupTags === undefined ? {} : { groupTags: tagBlocks.groupTags }),
      ...(privateFactsBlock === undefined ? {} : { privateFacts: privateFactsBlock }),
      ...(tagBlocks.memberTags === undefined ? {} : { memberTags: tagBlocks.memberTags }),
      ...(ctx.state.privacyPromptBlocks?.knownFacts === undefined
        ? {} : { knownFacts: ctx.state.privacyPromptBlocks.knownFacts }),
      ...(ctx.state.privacyPromptBlocks?.privateRule === undefined
        ? {} : { privacyRule: ctx.state.privacyPromptBlocks.privateRule }),
      ...(affinityBlock === undefined ? {} : { affinity: affinityBlock }),
      ...(stickersBlock ? { stickers: stickersBlock } : {}),
    },
    replySystemTemplate: ctx.state.promptTemplates.replySystem,
  };
  const injectedAffectBlocks = {
    ...(moodBlocks.mood ? { mood: redactSensitiveText(moodBlocks.mood) } : {}),
    ...(moodBlocks.float ? { float: redactSensitiveText(moodBlocks.float) } : {}),
    ...(affinityBlock ? { affinity: redactSensitiveText(affinityBlock) } : {}),
  };
  if (Object.keys(injectedAffectBlocks).length > 0) {
    ctx.state.injectedAffectBlocks = injectedAffectBlocks;
  }
  ctx.state.prompt = buildPromptMessages(promptOptions);
  ctx.state.promptBlocks = describePromptBlocks(promptOptions);
  ctx.state.promptHash = hashPromptMessages(ctx.state.prompt);
  return Object.keys(injectedAffectBlocks).length > 0
    ? { next: true, detail: { injectedAffectBlocks } }
    : { next: true };
});
