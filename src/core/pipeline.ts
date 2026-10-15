import { createRateLimiter } from './rate-limit.ts';
import { promptTemplateStore } from './prompt-templates.ts';
import { hashPromptMessages } from './prompt.ts';
import { isDebugEnabled } from '../config/debug.ts';
import { createIdleBackoff } from './activity/backoff.ts';
import { createActivityThreshold } from './activity/threshold.ts';
import { callSlot } from '../llm/slots.ts';
import { sessionId, type IncomingMessage } from './events.ts';
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
  };
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((milliseconds: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  }));
  const random = options.random ?? Math.random;
  const modelCall = options.callModel ?? callSlot;
  const rateLimiter = createRateLimiter(now);

  return async function processMessage(
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
        now,
        wait,
        random,
        modelCall: trackedModelCall,
        rateLimiter,
        trace,
        state,
      };
      const withPromptFingerprint = (detail: unknown): unknown => {
        const fingerprint = {
          templateVersion: promptTemplates.replySystem.version,
          visionTemplateVersion: promptTemplates.vision.version,
          judgeTemplateVersion: promptTemplates.judge.version,
          ...(ctx.state.promptHash ? { promptHash: ctx.state.promptHash } : {}),
          ...(ctx.state.promptFingerprints.length > 0
            ? { promptFingerprints: [...ctx.state.promptFingerprints] }
            : {}),
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
            detail: withPromptFingerprint(decisionDetail),
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
      for (const step of activeSteps) {
        const result = await step(ctx);
        if (!result.next) return recordDecision(result.reason, result.detail, result.replied ?? false);
      }
      return recordDecision('replied', {}, true);
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
  };
}
