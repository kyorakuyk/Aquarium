import { resolveSession } from '../config/resolve.ts';
import type { AquariumConfig } from '../config/schema.ts';
import { createActivityMessageRouter, type RoutedActivityOptions } from '../core/activity/router.ts';
import { resolveMode } from '../core/activity/mode.ts';
import { messageTrigger } from '../core/activity/trigger.ts';
import type { IncomingMessage } from '../core/shared/events.ts';
import { isManagementCommand, type ManagementCommands } from '../core/conversation/management.ts';
import type { SessionQueue } from '../core/conversation/session-queue.ts';
import { budgetState } from '../llm/budget.ts';

export interface AccountActivityRouterOptions<Timer> {
  now: () => number;
  setTimer: (callback: () => void, delayMs: number) => Timer;
  clearTimer: (timer: Timer) => void;
  queue: SessionQueue;
  getConfig: () => AquariumConfig;
  management: Pick<ManagementCommands, 'handle' | 'isMuted'>;
  costToday: () => number;
  processMessage: (message: IncomingMessage, options: RoutedActivityOptions) => Promise<unknown>;
  onError?: (error: unknown, message: IncomingMessage) => void;
}

export function createAccountActivityRouter<Timer>(
  options: AccountActivityRouterOptions<Timer>,
) {
  return createActivityMessageRouter({
    now: options.now,
    setTimer: options.setTimer,
    clearTimer: options.clearTimer,
    queue: options.queue,
    shouldBatch(message) {
      if (message.session.kind !== 'group') return false;
      const config = options.getConfig();
      const settings = resolveSession(config, message.session);
      if (!settings.enabled || options.management.isMuted(message.session)) return false;
      if (budgetState(config, options.costToday()) === 'exceeded') return false;
      if (resolveMode(settings, options.now()) === 'mention_only') return false;
      if (messageTrigger(message, settings.nicknames) !== 'none') return false;
      return !isManagementCommand(message, config.owner);
    },
    async processMessage(message, routedOptions) {
      if (!routedOptions.batched && await options.management.handle(message)) return;
      await options.processMessage(message, routedOptions);
    },
    onError: options.onError,
  });
}
