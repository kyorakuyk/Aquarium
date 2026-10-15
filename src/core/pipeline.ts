import { createRateLimiter } from './rate-limit.ts';
import { promptTemplateStore } from './prompt-templates.ts';
import { hashPromptMessages } from './prompt.ts';
import { callSlot } from '../llm/slots.ts';
import { sessionId, type IncomingMessage } from './events.ts';
import { contextStep } from './steps/context.ts';
import { deliverStep } from './steps/deliver.ts';
import { gateStep } from './steps/gate.ts';
import { generateStep } from './steps/generate.ts';
import { persistStep } from './steps/persist.ts';
import type {
  MessagePipelineOptions,
  PipelineModelCall,
  PipelineResult,
  ProcessMessageOptions,
  StepContext,
  StepResult,
} from './steps/types.ts';

export type {
  MessagePipelineOptions,
  PipelineModelCall,
  PipelineResult,
  PromptFingerprint,
  ProcessMessageOptions,
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
    const promptTemplates = options.getPromptTemplates?.() ?? promptTemplateStore.get();
    const promptFingerprints: StepContext['state']['promptFingerprints'] = [];
    const state: StepContext['state'] = { sentMessageIds: [], promptTemplates, promptFingerprints };
    const trackedModelCall: PipelineModelCall = async (slot, messages, callOptions) => {
      const templateVersion = slot === 'vision'
        ? promptTemplates.vision.version
        : promptTemplates.replySystem.version;
      const promptHash = hashPromptMessages(messages);
      promptFingerprints.push({ slot, templateVersion, promptHash });
      state.promptHash = promptHash;
      return modelCall(slot, messages, callOptions);
    };
    const ctx: StepContext = {
      message,
      processOptions,
      currentSessionId,
      options,
      now,
      wait,
      random,
      modelCall: trackedModelCall,
      rateLimiter,
      trace: [],
      state,
    };
    const withPromptFingerprint = (detail: unknown): unknown => {
      const fingerprint = {
        templateVersion: promptTemplates.replySystem.version,
        visionTemplateVersion: promptTemplates.vision.version,
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
      options.repository.recordDecision({
        time: now(),
        sessionId: currentSessionId,
        messageId: message.messageId,
        replied,
        reason,
        detail: withPromptFingerprint(detail),
      });
      return { replied, reason };
    };

    for (const step of steps) {
      const result = await step(ctx);
      if (!result.next) return recordDecision(result.reason, result.detail, result.replied ?? false);
    }
    return recordDecision('replied', {}, true);
  };
}
