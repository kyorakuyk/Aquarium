import { createRateLimiter } from '../shared/rate-limit.ts';
import { promptTemplateStore } from '../prompt/templates.ts';
import { hashPromptMessages } from '../prompt/index.ts';
import { isDebugEnabled } from '../../config/debug.ts';
import { createIdleBackoff } from '../activity/backoff.ts';
import { createActivityThreshold } from '../activity/threshold.ts';
import { resolveMode } from '../activity/mode.ts';
import { createSleepWakeState } from '../sleep/index.ts';
import { createAnchoredContextWindow } from './context-window.ts';
import { callSlot } from '../../llm/slots.ts';
import { resolveSession } from '../../config/resolve.ts';
import { sessionId, type IncomingMessage, type SessionKey } from '../shared/events.ts';
import { createEventAdvocacySender } from '../privacy/event-advocacy.ts';
import { contextStep } from './steps/context.ts';
import { deliverStep, replayDeliverStep } from './steps/deliver.ts';
import { gateStep } from './steps/gate.ts';
import { generateStep } from './steps/generate.ts';
import { persistStep } from './steps/persist.ts';
import type {
  MessagePipelineOptions,
  PipelineModelCall,
  PipelineResult,
  ProcessMessageOptions,
  ReplayOutcome,
  StepContext,
  StepResult,
} from './steps/types.ts';

export type {
  MessagePipelineOptions,
  PipelineModelCall,
  PipelineResult,
  PromptFingerprint,
  ProcessMessageOptions,
  ReplayOutcome,
  StepContext,
  StepResult,
  TraceEntry,
} from './steps/types.ts';

const steps: Array<(ctx: StepContext) => Promise<StepResult>> = [
  persistStep,
  gateStep,
  contextStep,
  generateStep,
  deliverStep,
];

export function createMessagePipeline(options: MessagePipelineOptions) {
  const pipelineOptions: MessagePipelineOptions = {
    ...options,
    idleBackoff: options.idleBackoff ?? createIdleBackoff(),
    activityThreshold: options.activityThreshold ?? createActivityThreshold(),
    sleepWakeState: options.sleepWakeState ?? createSleepWakeState(),
  };
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((milliseconds: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  }));
  const random = options.random ?? Math.random;
  const modelCall = options.callModel ?? callSlot;
  const rateLimiter = createRateLimiter(now);
  const contextWindow = createAnchoredContextWindow();
  const sendEventAdvocacy = createEventAdvocacySender({
    repository: pipelineOptions.repository,
    adapter: pipelineOptions.adapter,
    getConfig: pipelineOptions.getConfig,
    getNickname: pipelineOptions.getNickname,
    now,
    activityThreshold: pipelineOptions.activityThreshold ?? createActivityThreshold(),
    rateLimiter,
    ...(pipelineOptions.isMuted === undefined ? {} : { isMuted: pipelineOptions.isMuted }),
    ...(pipelineOptions.isOnline === undefined ? {} : { isOnline: pipelineOptions.isOnline }),
    ...(pipelineOptions.sleepWakeState === undefined ? {} : { sleepWakeState: pipelineOptions.sleepWakeState }),
    ...(pipelineOptions.privacyGateService === undefined ? {} : { privacyGateService: pipelineOptions.privacyGateService }),
    ...(pipelineOptions.idleBackoff === undefined ? {} : { idleBackoff: pipelineOptions.idleBackoff }),
  });

  async function sendSystemReply(session: SessionKey, text: string, cycleKey: string): Promise<boolean> {
    const config = pipelineOptions.getConfig();
    const settings = resolveSession(config, session);
    if (!config.sleep.enabled || !config.sleep.goodnight || !settings.enabled || pipelineOptions.isMuted?.(session)) {
      return false;
    }

    const sentAt = now();
    if (!rateLimiter.check(session, config.owner, settings.rate).allowed) return false;
    const currentSessionId = sessionId(session);
    const nickname = pipelineOptions.getNickname().trim() || String(session.account);
    const message: IncomingMessage = {
      session,
      messageId: `sleep-goodnight-${cycleKey}-${session.kind}-${session.peer}`,
      senderId: config.owner,
      senderName: nickname,
      segments: [{ type: 'text', text }],
      plainText: text,
      mentionsSelf: false,
      replyToSelf: false,
      time: sentAt,
    };
    const context: StepContext = {
      message,
      processOptions: { quoteReplyTo: false },
      currentSessionId,
      options: pipelineOptions,
      contextWindow,
      now,
      wait,
      random,
      modelCall,
      rateLimiter,
      trace: [],
      state: {
        config,
        settings: { ...settings, mode: resolveMode(settings, sentAt) },
        nickname,
        result: {
          text,
          provider: 'local',
          model: 'sleep-goodnight',
          usage: { inputTokens: 0, cachedTokens: 0, outputTokens: 0, costCny: 0 },
        },
        replyText: text,
        sentMessageIds: [],
        promptTemplates: pipelineOptions.getPromptTemplates?.() ?? promptTemplateStore.get(),
        promptFingerprints: [],
      },
    };
    const result = await deliverStep(context);
    if (context.state.sentMessageIds.length > 0) {
      try {
        pipelineOptions.repository.recordDecision({
          time: now(),
          sessionId: currentSessionId,
          messageId: message.messageId,
          replied: true,
          reason: 'goodnight',
          detail: { cycleKey, sentMessageIds: [...context.state.sentMessageIds] },
        });
      } catch (error) {
        pipelineOptions.onError?.(error, message);
      }
    }
    if (result.next) return false;
    return result.reason === 'replied' && result.replied === true;
  }

  async function processMessage(
    message: IncomingMessage,
    processOptions: ProcessMessageOptions = {},
  ): Promise<PipelineResult> {
    const currentSessionId = sessionId(message.session);
    const trace: StepContext['trace'] = [];
    let runState: StepContext['state'] | undefined;
    try {
      const promptTemplates = options.getPromptTemplates?.() ?? promptTemplateStore.get();
      const promptFingerprints: StepContext['state']['promptFingerprints'] = [];
      const state: StepContext['state'] = { sentMessageIds: [], promptTemplates, promptFingerprints };
      runState = state;
      const trackedModelCall: PipelineModelCall = async (slot, messages, callOptions) => {
        const templateVersion = slot === 'judge'
          ? promptTemplates.judge.version
          : slot === 'vision' ? promptTemplates.vision.version : promptTemplates.replySystem.version;
        const promptHash = hashPromptMessages(messages);
        promptFingerprints.push({ slot, templateVersion, promptHash });
        state.promptHash = promptHash;
        return modelCall(slot, messages, callOptions);
      };
      const ctx: StepContext = {
        message,
        processOptions,
        currentSessionId,
        options: pipelineOptions,
        contextWindow,
        now,
        wait,
        random,
        modelCall: trackedModelCall,
        rateLimiter,
        trace,
        state,
      };
      const withPromptFingerprint = (detail: unknown, includeAffectBlocks = false): unknown => {
        const fingerprint = {
          templateVersion: promptTemplates.replySystem.version,
          visionTemplateVersion: promptTemplates.vision.version,
          judgeTemplateVersion: promptTemplates.judge.version,
          affectTemplateVersion: promptTemplates.affect.version,
          ...(ctx.state.promptHash ? { promptHash: ctx.state.promptHash } : {}),
          ...(ctx.state.promptFingerprints.length > 0
            ? { promptFingerprints: [...ctx.state.promptFingerprints] }
            : {}),
          ...(ctx.state.promptBlocks ? { promptBlocks: [...ctx.state.promptBlocks] } : {}),
          ...(includeAffectBlocks && ctx.state.injectedAffectBlocks
            ? { injectedAffectBlocks: { ...ctx.state.injectedAffectBlocks } }
            : {}),
          ...(ctx.state.droppedTags ? { droppedTags: ctx.state.droppedTags } : {}),
          ...(ctx.state.privacyDecisionDetail ? { privacy: ctx.state.privacyDecisionDetail } : {}),
        };
        if (typeof detail === 'object' && detail !== null && !Array.isArray(detail)) {
          return { ...detail, ...fingerprint };
        }
        return detail === undefined ? fingerprint : { detail, ...fingerprint };
      };
      const recordDecision = (
        reason: string,
        detail: unknown = {},
        replied = false,
      ): PipelineResult => {
        const decisionDetail = runState?.activityDecisionDetail
          ? {
            ...runState.activityDecisionDetail,
            ...(typeof detail === 'object' && detail !== null && !Array.isArray(detail)
              ? detail as Record<string, unknown>
              : detail === undefined ? {} : { detail }),
          }
          : detail;
        if (!processOptions.replay) {
          options.repository.recordDecision({
            time: now(),
            sessionId: currentSessionId,
            messageId: message.messageId,
            replied,
            reason,
            detail: withPromptFingerprint(decisionDetail, replied),
          });
          return { replied, reason };
        }
        const replay: ReplayOutcome = {
          wouldReply: reason === 'replay',
          reason: reason === 'replay' ? 'replied' : reason,
          replyText: runState?.replyText ?? '',
          trace: [...trace],
          ...(runState?.result ? {
            provider: runState.result.provider,
            model: runState.result.model,
          } : {}),
          ...(runState?.replayReplyCostCny !== undefined
            ? { replyCostCny: runState.replayReplyCostCny }
            : runState?.result ? { replyCostCny: runState.result.usage.costCny } : {}),
          ...(runState?.replayTotalCostCny !== undefined
            ? { totalCostCny: runState.replayTotalCostCny }
            : runState?.result ? { totalCostCny: runState.result.usage.costCny } : {}),
          ...(runState?.parts ? { parts: [...runState.parts] } : {}),
        };
        return { replied, reason, replay };
      };

      const activeSteps = processOptions.replay
        ? [...steps.slice(0, -1), replayDeliverStep]
        : steps;
      const appraiseAfterReply = (): void => {
        const moodTask = pipelineOptions.moodService?.afterReply({
          account: message.session.account,
          sessionId: currentSessionId,
          senderId: message.senderId,
          messageId: message.messageId,
          ...(ctx.state.innerVoice?.length ? { innerVoice: ctx.state.innerVoice.join('\n') } : {}),
          moodSettings: ctx.state.personaMood,
          now: now(),
          template: promptTemplates.appraise,
          energySource: ctx.state.personaEnergySource ?? 'mixed',
        });
        if (!moodTask) return;
        void moodTask.catch((error: unknown) => {
          try {
            options.onError?.(error, message);
          } catch {
            // 后台情绪评估失败不能影响回复。
          }
        });
      };
      const stickerOutcome = (): Record<string, unknown> => ({
        stickerOffered: ctx.state.stickerOffered ?? null,
        stickerSent: ctx.state.stickerSent?.id ?? null,
        ...(ctx.state.stickerSent?.stickerOnly ? { stickerOnly: true } : {}),
      });
      for (const step of activeSteps) {
        const result = await step(ctx);
        if (!result.next) {
          const completedDetail = result.reason === 'replied'
            ? { ...(typeof result.detail === 'object' && result.detail !== null && !Array.isArray(result.detail)
              ? result.detail as Record<string, unknown>
              : {}), ...stickerOutcome() }
            : result.detail;
          const decision = recordDecision(result.reason, completedDetail, result.replied ?? false);
          if (!processOptions.replay && result.reason === 'replied' && result.replied === true) {
            appraiseAfterReply();
          }
          return decision;
        }
      }
      return recordDecision('replied', stickerOutcome(), true);
    } finally {
      if (!processOptions.replay && runState && runState.sentMessageIds.length > 0) {
        pipelineOptions.idleBackoff?.recordReply(currentSessionId);
        if (runState.proactiveMode) {
          pipelineOptions.activityThreshold?.recordProactiveReply(
            currentSessionId,
            runState.proactiveMode,
            now(),
          );
        }
      }
      try {
        const config = runState?.config ?? options.getConfig();
        if (!processOptions.replay && isDebugEnabled(config, currentSessionId)) {
          options.repository.recordPipelineTrace({
            time: now(),
            sessionId: currentSessionId,
            messageId: message.messageId,
            trace: [...trace],
          });
        }
      } catch (error) {
        options.onError?.(error, message);
      }
    }
  }
  return Object.assign(processMessage, { sendSystemReply, sendEventAdvocacy });
}
