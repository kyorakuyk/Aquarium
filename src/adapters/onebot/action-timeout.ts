import type { OneBotClient } from './client.ts';

const HEALTH_CHECK_TIMEOUT_MS = 1_000;
export const ADAPTER_ACTION_TIMEOUT_MS = 10_000;
export const SEND_ACTION_TIMEOUT_MS = 60_000;

export function timeoutForAction(action: string): number {
  return action.startsWith('send_') || action === 'add_custom_face' || action.startsWith('upload_')
    ? SEND_ACTION_TIMEOUT_MS
    : ADAPTER_ACTION_TIMEOUT_MS;
}

export class AdapterTimeoutError extends Error {
  constructor(action: string, timeoutMs: number) {
    super(`OneBot action ${action} timed out after ${timeoutMs}ms`);
    this.name = 'AdapterTimeoutError';
  }
}

export interface ActionTimeoutRequest<Client, Result> {
  action: string;
  client: Client;
  run: () => Promise<Result>;
  assertOnline?: () => void;
  timeoutMs: number;
}

export interface ActionTimeoutController<Client> {
  run<Result>(request: ActionTimeoutRequest<Client, Result>): Promise<Result>;
}

export interface ActionTimeoutControllerOptions<Client> {
  setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer: typeof globalThis.clearTimeout;
  isCurrentClient: (client: Client) => boolean;
  isCriticalAction: (action: string) => boolean;
  probeClient: (client: Client) => Promise<boolean>;
  retireClient: (client: Client) => void;
}

export function createActionTimeoutController<Client>(
  options: ActionTimeoutControllerOptions<Client>,
): ActionTimeoutController<Client> {
  let healthCheckInFlight: { client: Client; promise: Promise<boolean> } | undefined;

  function probeClient(client: Client): Promise<boolean> {
    if (healthCheckInFlight?.client === client) return healthCheckInFlight.promise;
    const probe = Promise.resolve().then(() => options.probeClient(client)).catch(() => false);
    let tracked: Promise<boolean>;
    tracked = probe.finally(() => {
      if (healthCheckInFlight?.promise === tracked) healthCheckInFlight = undefined;
    });
    healthCheckInFlight = { client, promise: tracked };
    return tracked;
  }

  return {
    async run<Result>(request: ActionTimeoutRequest<Client, Result>): Promise<Result> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = options.setTimer(
          () => reject(new AdapterTimeoutError(request.action, request.timeoutMs)),
          request.timeoutMs,
        );
      });
      try {
        return await Promise.race([Promise.resolve().then(() => {
          request.assertOnline?.();
          return request.run();
        }), timeout]);
      } catch (error) {
        if (error instanceof AdapterTimeoutError && options.isCurrentClient(request.client)) {
          if (options.isCriticalAction(request.action)) {
            options.retireClient(request.client);
          } else if (!await probeClient(request.client) && options.isCurrentClient(request.client)) {
            options.retireClient(request.client);
          }
        }
        throw error;
      } finally {
        if (timer !== undefined) options.clearTimer(timer);
      }
    },
  };
}

export function createOneBotActionTimeoutController(options: {
  getClient: () => OneBotClient;
  isOnline: () => boolean;
  isAccountVerified: () => boolean;
  getLastPacketAt: (client: OneBotClient) => number | undefined;
  getHeartbeatIntervalMs: () => number;
  now: () => number;
  onHealthStatus: (status: { online: boolean; good: boolean }) => void;
  setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer: typeof globalThis.clearTimeout;
  retireClient: (client: OneBotClient) => void;
}): ActionTimeoutController<OneBotClient> {
  return createActionTimeoutController({
    setTimer: options.setTimer,
    clearTimer: options.clearTimer,
    isCurrentClient: (client) => client === options.getClient(),
    isCriticalAction: (action) => action === 'connect' || action === 'get_login_info',
    probeClient: async (client) => {
      if (client !== options.getClient() || !options.isOnline() || !options.isAccountVerified() || !client.isConnected) {
        return false;
      }
      const lastPacketAt = options.getLastPacketAt(client);
      if (lastPacketAt === undefined
        || options.now() - lastPacketAt <= options.getHeartbeatIntervalMs() * 2) {
        return true;
      }
      try {
        const status = await client.getStatus({ timeoutMs: HEALTH_CHECK_TIMEOUT_MS });
        if (client !== options.getClient() || !options.isOnline() || !options.isAccountVerified() || !client.isConnected) {
          return false;
        }
        options.onHealthStatus({ online: status.online, good: status.good });
        return true;
      } catch {
        return false;
      }
    },
    retireClient: options.retireClient,
  });
}
