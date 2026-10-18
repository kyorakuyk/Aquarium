import { isDebugEnabled } from '../../config/debug.ts';
import type { AquariumConfig } from '../../config/schema.ts';
import type { SlotCallOptions } from '../../llm/slots.ts';
import type { StepContext } from './types.ts';

export function createSlotCallOptions(
  ctx: StepContext,
  config: AquariumConfig,
): SlotCallOptions {
  const debugEnabled = isDebugEnabled(config, ctx.currentSessionId);
  return {
    config,
    account: ctx.message.session.account,
    costToday: () => ctx.options.repository.costToday(),
    recordUsage: (usage) => {
      ctx.options.repository.recordUsage({ ...usage, account: ctx.message.session.account });
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
        record: (trace: Parameters<typeof ctx.options.repository.recordDebugTrace>[0]) => {
          ctx.options.repository.recordDebugTrace(trace);
        },
        onPromptHash: (hash: string) => { ctx.state.promptHash = hash; },
        onError: (error: unknown) => ctx.options.onError?.(error, ctx.message),
      },
    } : {}),
  };
}
