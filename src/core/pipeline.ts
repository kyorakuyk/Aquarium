import { createRateLimiter } from './rate-limit.ts';
import { callSlot } from '../llm/slots.ts';
import { sessionId, type IncomingMessage } from './events.ts';
import { contextStep } from './steps/context.ts';
import { deliverStep } from './steps/deliver.ts';
import { gateStep } from './steps/gate.ts';
import { generateStep } from './steps/generate.ts';
import { persistStep } from './steps/persist.ts';
import type { MessagePipelineOptions, PipelineResult, ProcessMessageOptions, StepContext, StepResult } from './steps/types.ts';

export type {
  MessagePipelineOptions,
  PipelineModelCall,
  PipelineResult,
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
    const ctx: StepContext = {
      message,
      processOptions,
      currentSessionId,
      options,
      now,
      wait,
      random,
      modelCall,
      rateLimiter,
      trace: [],
      state: { sentMessageIds: [] },
    };
    const withPromptHash = (detail: unknown): unknown => {
      const promptHash = ctx.state.promptHash;
      if (!promptHash) return detail;
      if (typeof detail === 'object' && detail !== null && !Array.isArray(detail)) {
        return { ...detail, promptHash };
      }
      return { detail, promptHash };
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
        detail: withPromptHash(detail),
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
